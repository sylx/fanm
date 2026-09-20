// 作品を束ねて、隔離した子プロセスで動かす。
//
// 1. esbuild で work.ts と runner.ts を一つの JS に束ねる（ビルド検査を兼ねる）。
// 2. node の permission model で読み書きを outDir に限り、ヒープに上限をかけて実行する。
// 3. 時間を超えたら SIGKILL。止まらないコードも外から終わらせる。
//
// TODO: node の permission model ではネットワークを塞げない。いまは静的検査で
// fetch などを禁じている。本番ではコンテナのネットワークを切った中で動かす。

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import type { Scenario } from "@fanm/work";
import { slowAdvice, stallAdvice } from "./pace.js";
import type { RunnerResult } from "./runner.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
const RUNNER = join(import.meta.dirname, "runner.ts");

export interface IsolatedOptions {
    readonly timeoutMs: number;
    readonly maxHeapMb: number;
}

export type IsolatedResult =
    | { readonly stage: "build"; readonly error: string }
    | { readonly stage: "crash"; readonly error: string }
    | { readonly stage: "timeout"; readonly error: string }
    | { readonly stage: "run"; readonly result: RunnerResult };

/** work.ts を一つの JS にする。公開用の作品ビルドとは別（こちらはエンジンごと束ねる）。 */
async function bundle(workPath: string, outDir: string): Promise<string | null> {
    const entry = [
        `import factory from ${JSON.stringify(resolve(workPath))};`,
        `import { record } from ${JSON.stringify(RUNNER)};`,
        `record(factory, process.argv[2], process.argv[3]);`
    ].join("\n");
    try {
        await build({
            stdin: { contents: entry, resolveDir: ROOT, loader: "ts", sourcefile: "entry.ts" },
            bundle: true,
            platform: "node",
            format: "esm",
            target: "node24",
            tsconfig: join(ROOT, "tsconfig.base.json"),
            outfile: join(outDir, "bundle.mjs"),
            sourcemap: "inline",
            logLevel: "silent"
        });
        return null;
    } catch (e) {
        const errors = (e as { errors?: { text: string; location?: { file: string; line: number } | null }[] }).errors;
        return errors?.map(m => `${m.location ? `${m.location.file}:${m.location.line}: ` : ""}${m.text}`).join("\n")
            ?? String(e);
    }
}

/** 時間切れの知らせ。どこまで進んだか、実機の何倍遅いかまで書く。 */
function timeoutMessage(outDir: string, frames: number, timeoutMs: number): string {
    const path = join(outDir, "progress.json");
    const seconds = timeoutMs / 1000;
    if (!existsSync(path)) {
        return `${seconds}秒たっても最初の60フレームすら描き終えなかった。1フレームの処理が重すぎる。`;
    }
    const { frame, ms } = JSON.parse(readFileSync(path, "utf8")) as { frame: number; ms: number };
    const perFrame = ms / Math.max(1, frame);
    const stalled = seconds - ms / 1000;
    // そこまで速く走っていたなら、遅いのではなく、あるフレームで止まっている。
    return perFrame < 5 && stalled > 10
        ? stallAdvice(frame, stalled)
        : slowAdvice(frames, frame, perFrame, seconds);
}

export async function runIsolated(workPath: string, scenario: Scenario, outDir: string, options: IsolatedOptions): Promise<IsolatedResult> {
    const buildError = await bundle(workPath, outDir);
    if (buildError) return { stage: "build", error: buildError };

    const scenarioPath = join(outDir, "scenario.json");
    writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2));

    const child = spawn(process.execPath, [
        "--permission",
        "--enable-source-maps",
        `--allow-fs-read=${outDir}`,
        `--allow-fs-write=${outDir}`,
        `--max-old-space-size=${options.maxHeapMb}`,
        join(outDir, "bundle.mjs"), scenarioPath, outDir
    ], { cwd: outDir, stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.stdout.resume();

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
    const code = await new Promise<number | null>(done => child.on("close", done));
    clearTimeout(timer);

    if (timedOut) return { stage: "timeout", error: timeoutMessage(outDir, scenario.frames, options.timeoutMs) };
    const resultPath = join(outDir, "result.json");
    if (code !== 0 || !existsSync(resultPath)) {
        return { stage: "crash", error: `子プロセスが終了コード ${code} で落ちた\n${stderr}` };
    }
    return { stage: "run", result: JSON.parse(readFileSync(resultPath, "utf8")) as RunnerResult };
}
