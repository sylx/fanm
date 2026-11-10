// 定額の契約で使える公式の CLI（Claude Code、Codex）を、文章を書かせるだけの相手として
// 呼ぶための共通部分。相手ごとの違い（引数、出力の読み方）は claude-code.ts と codex.ts。
//
// API を直接叩く相手（claude.ts、openai.ts）との違い:
//
//   費用     従量ではなく、契約の枠から引かれる。台帳には $0 で記録する。代わりに
//            枠が尽きることがあり、そのときは ProviderError の "limit" にして、
//            その回だけ別の相手に書かせる（jobs/make.ts）。
//   会話     CLI は頼みを一つしか受け取らない。system も修正のやりとりも、一つの
//            文章に畳んで標準入力から渡す（引数にすると長さの上限に当たる）。
//   道具     CLI はエージェントなので、放っておくとファイルを作ったりコマンドを
//            走らせたりする。道具は切り、空のディレクトリで動かす。
//   鍵       子プロセスには必要な環境変数だけを渡す。API キーが見えると CLI は
//            そちらを使って従量で請求するし、公開先の鍵を渡す理由もない。

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { CompletionRequest } from "./provider.js";
import { ProviderError } from "./provider.js";

/** JSON だけを返させるための一行。 */
export const JSON_ONLY = "返事は JSON オブジェクトひとつだけにする。前置きも、囲みの ``` も書かない。";

/** エージェントとして動こうとするのを止める一行。 */
const NO_TOOLS = "これは文章を書く依頼です。コマンドの実行、ファイルの読み書き、検索はしないでください。"
    + "求められた全文を、返事の本文にそのまま書いてください。";

/** 囲みが付いて返ってきた JSON を裸にする。 */
export function unfence(text: string): string {
    const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
    return (fenced ? fenced[1] : text).trim();
}

/**
 * 会話を一つの文章に畳む。
 *
 * 頼みが一つだけ（企画、最初の生成）なら、資料のあとにその頼みを置く。修正のように
 * やりとりが続いているときは、誰の発言かを見出しで分けて順に並べ、最後の頼みに
 * 答えさせる。
 */
export function flatten(request: CompletionRequest): string {
    const system = request.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const turns = request.messages.filter(m => m.role !== "system");
    const parts = [NO_TOOLS, "# 資料\n\n" + system];
    if (turns.length <= 1) {
        parts.push("# 依頼\n\n" + (turns[0]?.content ?? ""));
    } else {
        const last = turns[turns.length - 1];
        parts.push("# これまでのやりとり\n\n" + turns.slice(0, -1)
            .map(t => `## ${t.role === "user" ? "依頼" : "あなたの返事"}\n\n${t.content}`).join("\n\n"));
        parts.push("# 今回の依頼\n\n" + last.content);
    }
    if (request.json) parts.push(JSON_ONLY);
    return parts.join("\n\n---\n\n");
}

/** 子プロセスへ渡してよい環境変数。ここに無いもの（API キー、公開先の鍵）は渡さない。 */
const PASS = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "TMPDIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"];

export function childEnv(extra: readonly string[], set: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of [...PASS, ...extra]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return { ...env, ...set };
}

export interface CliRun {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    /** 標準入力へ流す頼み。 */
    readonly input: string;
    readonly timeoutMs: number;
    /** 標準出力の一行（JSON として読めたもの）。 */
    readonly onEvent: (event: Record<string, unknown>) => void;
}

/**
 * CLI を空のディレクトリで動かし、標準出力の JSON を一行ずつ渡す。終了コードと
 * 標準エラーの末尾を返す。時間切れは殺して "network" にする（どこまで進んだか
 * 分からないが、定額なので費用の心配は無い）。
 */
export async function runCli(run: CliRun): Promise<{ code: number | null; stderr: string }> {
    const cwd = mkdtempSync(join(tmpdir(), "fanm-cli-"));
    try {
        return await new Promise((resolve, reject) => {
            const child = spawn(run.command, [...run.args], { cwd, env: run.env, stdio: ["pipe", "pipe", "pipe"] });
            let stderr = "";
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                reject(new ProviderError(`${run.command} が ${run.timeoutMs / 60_000} 分で終わらなかった`, "network", false));
            }, run.timeoutMs);
            child.on("error", e => {
                clearTimeout(timer);
                const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
                reject(new ProviderError(
                    missing ? `${run.command} が見つからない。イメージに入っているか確かめる` : `${run.command} を起動できない: ${e.message}`,
                    missing ? "auth" : "network", false
                ));
            });
            child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
            createInterface({ input: child.stdout }).on("line", line => {
                if (!line.startsWith("{")) return;
                try {
                    run.onEvent(JSON.parse(line) as Record<string, unknown>);
                } catch {
                    // JSON でない行（進み具合の表示など）は読み飛ばす。
                }
            });
            child.on("close", code => {
                clearTimeout(timer);
                resolve({ code, stderr });
            });
            child.stdin.on("error", () => { /* 相手が先に閉じた。結果は close で分かる。 */ });
            child.stdin.end(run.input);
        });
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
}

/**
 * CLI の失敗の文面から、何が起きたかを見分ける。
 *
 * - 枠切れ      "limit"。人は呼ばない。`until` まで（分からなければ3時間）この相手を休ませる。
 * - 認証切れ    "auth"。人がログインし直すまで直らないので、知らせる。
 * - それ以外    "server"。時間を置いて再試行する。
 */
export function cliError(who: string, message: string, until?: Date): ProviderError {
    const text = `${who}: ${message.trim().slice(0, 500) || "理由の分からない失敗"}`;
    if (until || /usage limit|rate limit|limit reached|quota|too many requests|\b429\b/i.test(message)) {
        return new ProviderError(text, "limit", false, until ?? new Date(Date.now() + 3 * 3600_000));
    }
    if (/\b401\b|\b403\b|unauthori[sz]ed|not logged in|log ?in|authenticat|oauth|token (?:has )?expired|invalid api key/i.test(message)) {
        return new ProviderError(text, "auth", false);
    }
    return new ProviderError(text, "server", false);
}
