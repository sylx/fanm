// 作品をヘッドレスのfantasy-msxで動かし、決めたフレームで撮影する。
// 生成コードを直接呼ぶので、バッチ本体からは使わず runner.ts（子プロセス）から使う。
//
// ctx.text はふだんブラウザに字を組ませる。node には組む相手がいないので、
// 同じドット面から取り出した字を並べるラスタライザを差す（typeset.ts）。
//
// 同梱の絵（env.images）を渡したときは、その使われ方も数える（ImageUse）。
// 絵を同梱した作品が絵を画面に出していないなら、それは一枚絵の作品ではない。

import { BUTTON, boot } from "fantasy-msx";
import { readFrame, type Image } from "fantasy-msx/tools/capture.js";
import { createEnv, type Scenario, type WorkFactory, type WorkImage } from "@fanm/work";
import type { ReduceOptions } from "fantasy-msx";
import { PACE } from "./pace.js";
import { rasteriseWithDots } from "./typeset.js";

export interface Capture {
    readonly frame: number;
    readonly image: Image;
    /** 撮影時点で blitter に残っていたジョブ数。 */
    readonly pending: number;
    readonly musicPlaying: boolean;
}

/** 同梱の絵の使われ方。検査で絵を画面に出したかを判断する材料。 */
export interface ImageUse {
    /** ctx.image.reduce に渡された絵の名前。 */
    reduced: string[];
    /** 減色して出来た画素の数（同梱の絵から作ったものだけ）。 */
    reducedPixels: number;
    /** 最初の減色のあと、drawImage（image.draw / drawNow も通る）で置いた画素の数。 */
    drawnPixels: number;
}

export function emptyImageUse(): ImageUse {
    return { reduced: [], reducedPixels: 0, drawnPixels: 0 };
}

/**
 * 絵の使われ方を数える仕掛けを差す。作品が呼ぶ ctx.image も ctx.gfx も、この
 * runtime の同じ物なので、その物の口に割り込めば作品のどこから呼ばれても数えられる。
 *
 * 置いた画素は、どの絵から作ったかまでは追わない。升目ごとに切り出して置く作品は
 * 配列を写し直すので、元の絵との繋がりが切れる。だから減色のあとに置かれた量で見る。
 */
function watchImages(runtime: ReturnType<typeof boot>, images: Readonly<Record<string, WorkImage>>, use: ImageUse): void {
    const names = new Map(Object.entries(images).map(([name, image]) => [image as object, name]));
    if (!names.size) return;
    const { image, gfx } = runtime.bios;
    const reduce = image.reduce.bind(image);
    image.reduce = (source, options?: ReduceOptions) => {
        const result = reduce(source, options);
        const name = names.get(source);
        if (name !== undefined) {
            if (!use.reduced.includes(name)) use.reduced.push(name);
            use.reducedPixels += result.width * result.height;
        }
        return result;
    };
    const count = (width: number, height: number) => {
        if (use.reduced.length) use.drawnPixels += Math.max(0, width) * Math.max(0, height);
    };
    const queued = gfx.drawImage.bind(gfx);
    gfx.drawImage = (x, y, width, height, pixels, transparent) => {
        count(width, height);
        return queued(x, y, width, height, pixels, transparent);
    };
    const raster = gfx.now;
    const immediate = raster.drawImage.bind(raster);
    raster.drawImage = (x, y, width, height, pixels, transparent) => {
        count(width, height);
        return immediate(x, y, width, height, pixels, transparent);
    };
}

export type RunResult =
    | { readonly ok: true; readonly captures: readonly Capture[] }
    | { readonly ok: false; readonly frame: number; readonly error: string; readonly captures: readonly Capture[] }
    /** 遅すぎて最後まで走らないと分かったので、途中でやめた。 */
    | { readonly ok: false; readonly slow: true; readonly frame: number; readonly msPerFrame: number; readonly captures: readonly Capture[] };

export function runHeadless(
    factory: WorkFactory, scenario: Scenario, onProgress?: (frame: number) => void,
    images: Readonly<Record<string, WorkImage>> = {},
    /** 渡せば、同梱の絵の使われ方をここに数える。 */
    use: ImageUse = emptyImageUse()
): RunResult {
    const runtime = boot();
    runtime.bios.text.rasteriser = rasteriseWithDots;
    watchImages(runtime, images, use);
    const captures: Capture[] = [];
    const wanted = new Set(scenario.captures);
    const started = performance.now();
    let frame = 0;
    try {
        runtime.run(factory(createEnv(scenario.seed, images)));
        for (; frame < scenario.frames; ++frame) {
            for (const input of scenario.inputs) {
                if (input.frame !== frame) continue;
                if (input.kind === "key") runtime.input.setKey(input.code, input.down);
                else runtime.input.setButton(BUTTON[input.code], input.down);
            }
            runtime.step();
            if (frame % 60 === 0) {
                onProgress?.(frame);
                // 見込みのない作品に120秒かけない。同じ助言を早く返すほうがよい。
                const msPerFrame = (performance.now() - started) / frame;
                if (frame >= PACE.after && msPerFrame > PACE.maxMsPerFrame) {
                    return { ok: false, slow: true, frame, msPerFrame, captures };
                }
            }
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
