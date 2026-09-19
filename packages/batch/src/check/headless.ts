// 作品をヘッドレスのfantasy-msxで動かし、決めたフレームで撮影する。
//
// TODO: 生成コードは子プロセス（またはworker）で動かし、時間・メモリを
// 制限して外から殺せるようにする。いまは同じプロセスで動かしている。

import { BUTTON, boot } from "fantasy-msx";
import { readFrame, type Image } from "fantasy-msx/tools/capture.js";
import { createEnv, type Scenario, type WorkFactory } from "@fanm/work";

export interface Capture {
    readonly frame: number;
    readonly image: Image;
}

export type CheckResult =
    | { readonly ok: true; readonly captures: readonly Capture[] }
    | { readonly ok: false; readonly frame: number; readonly error: string; readonly captures: readonly Capture[] };

export function runHeadless(factory: WorkFactory, scenario: Scenario): CheckResult {
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
                captures.push({ frame, image: readFrame(runtime.bios.system.machine, runtime.screen.pixelAspect) });
            }
        }
        return { ok: true, captures };
    } catch (e) {
        return { ok: false, frame, error: e instanceof Error ? e.stack ?? e.message : String(e), captures };
    } finally {
        runtime.stop();
    }
}
