// 作品をヘッドレスのfantasy-msxで動かし、決めたフレームで撮影する。
// 生成コードを直接呼ぶので、バッチ本体からは使わず runner.ts（子プロセス）から使う。

import { BUTTON, boot } from "fantasy-msx";
import { readFrame, type Image } from "fantasy-msx/tools/capture.js";
import { createEnv, type Scenario, type WorkFactory } from "@fanm/work";

export interface Capture {
    readonly frame: number;
    readonly image: Image;
    /** 撮影時点で blitter に残っていたジョブ数。 */
    readonly pending: number;
    readonly musicPlaying: boolean;
}

export type RunResult =
    | { readonly ok: true; readonly captures: readonly Capture[] }
    | { readonly ok: false; readonly frame: number; readonly error: string; readonly captures: readonly Capture[] };

export function runHeadless(factory: WorkFactory, scenario: Scenario): RunResult {
    const runtime = boot();
    const captures: Capture[] = [];
    const wanted = new Set(scenario.captures);
    let frame = 0;
    try {
        runtime.run(factory(createEnv(scenario.seed)));
        for (; frame < scenario.frames; ++frame) {
            for (const input of scenario.inputs) {
                if (input.frame !== frame) continue;
                if (input.kind === "key") runtime.input.setKey(input.code, input.down);
                else runtime.input.setButton(BUTTON[input.code], input.down);
            }
            runtime.step();
            if (wanted.has(frame)) {
                captures.push({
                    frame,
                    image: readFrame(runtime.bios.system.machine, runtime.screen.pixelAspect),
                    pending: runtime.bios.gfx.pending,
                    musicPlaying: runtime.bios.bgm.playing
                });
            }
        }
        return { ok: true, captures };
    } catch (e) {
        return { ok: false, frame, error: e instanceof Error ? e.stack ?? e.message : String(e), captures };
    } finally {
        runtime.stop();
    }
}
