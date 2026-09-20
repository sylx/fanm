// 子プロセス側。一つの作品を動かし、撮影と所見を outDir に書く。
//
// 生成コードはこのプロセスの中だけで動く。親（isolated.ts）が作品と
// このファイルを一つの JS に束ね、時間とメモリの上限をかけ、読み書きを
// outDir に限った node で実行する。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePNG } from "fantasy-msx/tools/png.js";
import type { Scenario, WorkFactory } from "@fanm/work";
import { runHeadless } from "./headless.js";
import { measure, type ImageStats } from "./stats.js";

export interface RunnerCapture {
    readonly frame: number;
    readonly file: string;
    readonly pending: number;
    readonly musicPlaying: boolean;
    readonly stats: ImageStats;
}

export interface RunnerResult {
    readonly ok: boolean;
    readonly error?: string;
    readonly errorFrame?: number;
    /** 遅すぎて途中でやめた。 */
    readonly slow?: boolean;
    readonly captures: readonly RunnerCapture[];
    readonly msPerFrame: number;
}

/** 束ねた入口から呼ばれる。factory は作品の default export。 */
export function record(factory: unknown, scenarioPath: string, outDir: string): void {
    const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;
    let result: RunnerResult;
    const started = performance.now();
    try {
        if (typeof factory !== "function") throw new Error("work.ts の default export が関数ではない");
        // 途中経過。時間切れで殺されたとき、親がどこまで進んだかを知るため。
        const progress = join(outDir, "progress.json");
        const run = runHeadless(factory as WorkFactory, scenario, frame => {
            writeFileSync(progress, JSON.stringify({ frame, ms: performance.now() - started }));
        });
        let previous: Uint32Array | undefined;
        const captures = run.captures.map(capture => {
            const file = `${capture.frame}.png`;
            const { image } = capture;
            writeFileSync(join(outDir, file), encodePNG(image.pixels, image.width, image.height));
            const stats = measure(image.pixels, previous);
            previous = image.pixels;
            return { frame: capture.frame, file, pending: capture.pending, musicPlaying: capture.musicPlaying, stats };
        });
        const msPerFrame = (performance.now() - started) / Math.max(1, run.ok ? scenario.frames : run.frame);
        result = run.ok
            ? { ok: true, captures, msPerFrame }
            : "slow" in run
                ? { ok: false, slow: true, errorFrame: run.frame, captures, msPerFrame: run.msPerFrame }
                : { ok: false, error: run.error, errorFrame: run.frame, captures, msPerFrame };
    } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.stack ?? e.message : String(e), captures: [], msPerFrame: 0 };
    }
    writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2));
}
