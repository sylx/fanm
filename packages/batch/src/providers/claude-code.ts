// Claude を、定額の契約（Pro / Max）の枠で使う。公式の CLI（Claude Code）を
// `claude -p` で一回ずつ呼ぶ。API を直接叩く claude.ts とは別の相手。
//
// 認証は、手元で `claude setup-token` を実行して出てきた長期のトークンを、環境変数
// CLAUDE_CODE_OAUTH_TOKEN で渡す。手元では、ふだんの Claude Code のログインがそのまま
// 使われる。トークンを抜き出して SDK から API を叩くことはしない（それは契約の外）。
//
// 枠は、人がふだん使う Claude Code と共有している。尽きたら "limit" を投げ、その回は
// 別の相手が書く。共通の作法は cli.ts。

import type { Completion, CompletionRequest, OnDelta, Provider } from "./provider.js";
import { childEnv, cliError, flatten, runCli, unfence } from "./cli.js";

/** 長期のトークンを入れる環境変数。Claude Code が自分で読む名前。 */
export const CLAUDE_CODE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/** 道具も資料も渡さないので、役だけを一行で伝える。資料と頼みは標準入力から渡す。 */
const ROLE = "あなたは MSX2 のデモシーンの作り手です。渡された資料に従い、依頼された文章だけを書きます。";

/** バッチの思考の深さを、Claude Code の --effort に読み替える。 */
const EFFORT = { none: "low", low: "low", high: "high", max: "max" } as const;

interface RateLimit {
    readonly status?: string;
    readonly resetsAt?: number;
}

interface RawUsage {
    readonly input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly output_tokens?: number;
    readonly output_tokens_details?: { readonly thinking_tokens?: number };
}

export class ClaudeCode implements Provider {
    readonly name = "claude-code";

    constructor(
        readonly model: string,
        /** 応答を待つ上限。思考つきの長い生成に合わせて長め。 */
        private readonly timeoutMs = 20 * 60_000,
        private readonly command = "claude"
    ) {}

    /** 定額なので、台帳に載せる額は無い。 */
    estimateMaxUsd(): number {
        return 0;
    }

    estimatePartialUsd(): number {
        return 0;
    }

    async complete(request: CompletionRequest, onDelta?: OnDelta): Promise<Completion> {
        let text = "";
        let final: string | undefined;
        let failed: string | undefined;
        let stop: string | undefined;
        let usage: RawUsage = {};
        let rate: RateLimit = {};

        const { code, stderr } = await runCli({
            command: this.command,
            args: [
                "-p",
                "--model", this.model,
                "--effort", EFFORT[request.reasoningEffort],
                "--system-prompt", ROLE,
                // 道具は一つも渡さない。書くだけ。
                "--tools", "",
                "--strict-mcp-config",
                "--disable-slash-commands",
                "--no-session-persistence",
                "--output-format", "stream-json", "--verbose", "--include-partial-messages"
            ],
            env: childEnv([CLAUDE_CODE_TOKEN_ENV, "CLAUDE_CONFIG_DIR"], {
                CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.maxOutputTokens)
            }),
            input: flatten(request),
            timeoutMs: this.timeoutMs,
            onEvent: event => {
                if (event.type === "rate_limit_event") {
                    rate = (event.rate_limit_info ?? {}) as RateLimit;
                } else if (event.type === "stream_event") {
                    const inner = event.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string } };
                    if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta") {
                        text += inner.delta.text ?? "";
                        onDelta?.("content", inner.delta.text ?? "");
                    } else if (inner.type === "content_block_delta" && inner.delta?.type === "thinking_delta") {
                        onDelta?.("reasoning", inner.delta.thinking ?? "");
                    } else if (inner.type === "message_delta" && inner.delta?.stop_reason) {
                        stop = inner.delta.stop_reason;
                    }
                } else if (event.type === "result") {
                    if (event.is_error) failed = String(event.result ?? event.subtype ?? "");
                    else if (typeof event.result === "string") final = event.result;
                    if (typeof event.stop_reason === "string") stop = event.stop_reason;
                    usage = (event.usage ?? {}) as RawUsage;
                }
            }
        });

        if (failed !== undefined || code !== 0) {
            // 枠切れは、失敗の文面より先に rate_limit_event に出ている。
            const until = rate.status === "rejected" && rate.resetsAt ? new Date(rate.resetsAt * 1000) : undefined;
            throw cliError(`Claude Code（${this.model}）`, failed || stderr || `終了コード ${code}`, until);
        }

        const body = final ?? text;
        const read = usage.cache_read_input_tokens ?? 0;
        return {
            text: request.json ? unfence(body) : body,
            usage: {
                inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + read,
                cachedInputTokens: read,
                outputTokens: usage.output_tokens ?? 0,
                reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
                usd: 0
            },
            truncated: stop === "max_tokens" || stop === "model_context_window_exceeded"
        };
    }
}
