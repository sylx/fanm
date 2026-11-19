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
//
// 絵も描ける（CodexPainter、D部門）。Codex は画像生成の道具を持っていて、
// `codex exec` からも使える。描いた絵は JSON のイベントには流れてこず、
// CODEX_HOME/generated_images/<thread_id>/ に PNG で置かれる。

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Completion, CompletionRequest, OnDelta, Provider } from "./provider.js";
import { ProviderError } from "./provider.js";
import type { Painter, Painting, PaintRequest } from "./painter.js";
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

/** `codex exec` の共通の引数。会話を残さず、設定ファイルも読まず、読むことしかできないようにする。 */
function execArgs(model: string, effort: "low" | "high"): string[] {
    return [
        "exec",
        "--json",
        // 会話を残さない。設定ファイルも読まない（認証だけは CODEX_HOME から読む）。
        "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
        // 書くだけなので、何かを走らせようとしても読むことしかできないようにしておく。
        "--sandbox", "read-only",
        ...(model === "default" ? [] : ["--model", model]),
        "-c", `model_reasoning_effort="${effort}"`,
        "-"
    ];
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
            args: execArgs(this.model, EFFORT[request.reasoningEffort]),
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

/** 縦横比を、道具への頼みの言葉にする。 */
const ASPECT_WORDS: Record<PaintRequest["aspect"], string> = {
    "4:3": "横長（4:3）",
    "1:1": "正方形（1:1）",
    "3:4": "縦長（3:4）",
    "16:9": "横長（16:9）"
};

/**
 * Codex に絵を一枚描かせる。定額の枠の中なので、台帳に載せる額は無い。
 *
 * 描いた絵は CODEX_HOME/generated_images/<thread_id>/ に置かれる。読んだら
 * そのディレクトリごと消す（本番では永続ボリュームの上なので、残すと積もる）。
 */
export class CodexPainter implements Painter {
    readonly name = "codex";

    constructor(
        /** 道具を呼ぶだけなので軽いモデルでよい。`default` なら契約の既定。 */
        readonly model: string,
        private readonly timeoutMs = 10 * 60_000,
        private readonly command = "codex"
    ) {}

    estimateMaxUsd(): number {
        return 0;
    }

    async paint(request: PaintRequest): Promise<Painting> {
        let thread: string | undefined;
        let said = "";
        let failed: string | undefined;
        let usage: RawUsage = {};

        const { code, stderr } = await runCli({
            command: this.command,
            args: execArgs(this.model, "low"),
            env: childEnv([CODEX_HOME_ENV]),
            input: [
                "画像生成の道具を一度だけ使って、次の絵を一枚描いてください。",
                "コマンドの実行、ファイルの読み書き、検索はしないでください。",
                "描き終えたら「DONE」とだけ返事してください。",
                "",
                `縦横比: ${ASPECT_WORDS[request.aspect]}`,
                "",
                "# 絵",
                "",
                request.prompt
            ].join("\n"),
            timeoutMs: this.timeoutMs,
            onEvent: event => {
                const item = event.item as { type?: string; text?: string } | undefined;
                if (event.type === "thread.started") thread = String(event.thread_id ?? "");
                else if (event.type === "item.completed" && item?.type === "agent_message") said = item.text ?? "";
                else if (event.type === "turn.completed") usage = (event.usage ?? {}) as RawUsage;
                else if (event.type === "turn.failed") failed = String((event.error as { message?: string } | undefined)?.message ?? "");
                else if (event.type === "error") failed = String(event.message ?? "");
            }
        });

        const dir = thread ? join(codexHome(), "generated_images", thread) : undefined;
        try {
            if (failed !== undefined || code !== 0) {
                throw cliError(`Codex（${this.model}）`, failed || stderr || `終了コード ${code}`);
            }
            const file = dir && newestPng(dir);
            if (!file) {
                // 道具を使わずに返事だけした。描くかどうかは相手次第なので、時間を置いて頼み直す。
                throw new ProviderError(`Codex（${this.model}）が絵を描かなかった: ${said.slice(0, 200) || "返事なし"}`, "server", false);
            }
            return {
                bytes: new Uint8Array(readFileSync(file)),
                mime: "image/png",
                usage: {
                    inputTokens: usage.input_tokens ?? 0,
                    cachedInputTokens: usage.cached_input_tokens ?? 0,
                    outputTokens: usage.output_tokens ?? 0,
                    reasoningTokens: usage.reasoning_output_tokens ?? 0,
                    usd: 0
                }
            };
        } finally {
            if (dir) rmSync(dir, { recursive: true, force: true });
        }
    }
}

/** Codex が認証と生成物を置く場所。CODEX_HOME が無ければ Codex の既定（~/.codex）。 */
function codexHome(): string {
    return process.env[CODEX_HOME_ENV] || join(homedir(), ".codex");
}

/** ディレクトリの中でいちばん新しい PNG。道具を二度使っていたら、後のほうを採る。 */
function newestPng(dir: string): string | undefined {
    if (!existsSync(dir)) return undefined;
    return readdirSync(dir)
        .filter(name => name.endsWith(".png"))
        .map(name => join(dir, name))
        .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
        .at(-1);
}
