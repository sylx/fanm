// OpenAI のモデルを、ChatGPT の定額の契約（Plus / Pro）の枠で使う。公式の CLI
// （Codex）を `codex exec` で一回ずつ呼ぶ。API を直接叩く openai.ts とは別の相手。
//
// 認証は CODEX_HOME（本番では永続ボリュームの上、/data/codex）の auth.json。
// 動かす機械の上で一度 `codex login --device-auth` を済ませておく。Codex は
// およそ8日ごとにトークンを更新して auth.json に書き戻すので、置き場所が永続で
// あること、ほかの機械と同じ auth.json を使い回さないことが要る（使い回すと、
// 片方の更新でもう片方が切れる）。
// https://developers.openai.com/codex/auth/ci-cd-auth
//
// 枠が尽きたら "limit" を投げ、その回は別の相手が書く。共通の作法は cli.ts。

import type { Completion, CompletionRequest, OnDelta, Provider } from "./provider.js";
import { childEnv, cliError, flatten, runCli, unfence } from "./cli.js";

/** auth.json の置き場所を指す環境変数。Codex が自分で読む名前。 */
export const CODEX_HOME_ENV = "CODEX_HOME";

/** バッチの思考の深さを、Codex の model_reasoning_effort に読み替える。 */
const EFFORT = { none: "low", low: "low", high: "high", max: "high" } as const;

interface RawUsage {
    readonly input_tokens?: number;
    readonly cached_input_tokens?: number;
    readonly output_tokens?: number;
    readonly reasoning_output_tokens?: number;
}

export class Codex implements Provider {
    readonly name = "codex";

    constructor(
        /** `default` なら、契約で使える既定のモデルに任せる（-m を付けない）。 */
        readonly model: string,
        private readonly timeoutMs = 20 * 60_000,
        private readonly command = "codex"
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
        let failed: string | undefined;
        let usage: RawUsage = {};

        const { code, stderr } = await runCli({
            command: this.command,
            args: [
                "exec",
                "--json",
                // 会話を残さない。設定ファイルも読まない（認証だけは CODEX_HOME から読む）。
                "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
                // 書くだけなので、何かを走らせようとしても読むことしかできないようにしておく。
                "--sandbox", "read-only",
                ...(this.model === "default" ? [] : ["--model", this.model]),
                "-c", `model_reasoning_effort="${EFFORT[request.reasoningEffort]}"`,
                "-"
            ],
            env: childEnv([CODEX_HOME_ENV]),
            input: flatten(request),
            timeoutMs: this.timeoutMs,
            onEvent: event => {
                const item = event.item as { type?: string; text?: string } | undefined;
                if (event.type === "item.completed" && item?.type === "agent_message") {
                    // 途中経過の発言が先に来ることがある。答えは最後の発言。
                    text = item.text ?? "";
                    onDelta?.("content", text);
                } else if (event.type === "item.completed" && item?.type === "reasoning") {
                    onDelta?.("reasoning", item.text ?? "");
                } else if (event.type === "turn.completed") {
                    usage = (event.usage ?? {}) as RawUsage;
                } else if (event.type === "turn.failed") {
                    failed = String((event.error as { message?: string } | undefined)?.message ?? "");
                } else if (event.type === "error") {
                    failed = String(event.message ?? "");
                }
            }
        });

        if (failed !== undefined || code !== 0) {
            throw cliError(`Codex（${this.model}）`, failed || stderr || `終了コード ${code}`);
        }

        return {
            text: request.json ? unfence(text) : text,
            usage: {
                inputTokens: usage.input_tokens ?? 0,
                cachedInputTokens: usage.cached_input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
                reasoningTokens: usage.reasoning_output_tokens ?? 0,
                usd: 0
            },
            // Codex は出力上限で切れたかどうかを伝えてこない。切れていれば、書式の検査で落ちる。
            truncated: false
        };
    }
}
