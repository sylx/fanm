// 描く段（D部門）。企画が決めた絵を描き手に描かせ、作品の images/ に置く。
//
//     描く（providers/ の Painter、予算は call.ts の callPainter）
//       → 縮めて PNG に直す（normalize.ts）
//       → <作品のディレクトリ>/images/<名前>.png
//
// 置いた絵は、検査では env.images.<名前> として作品に届く（check/images.ts）。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_NAME } from "@fanm/work";
import type { Ledger } from "../budget/ledger.js";
import { IMAGES_DIR } from "../check/images.js";
import { callPainter, type CallLog } from "../providers/call.js";
import { CodexPainter } from "../providers/codex.js";
import type { Aspect, Painter } from "../providers/painter.js";
import { normalize } from "./normalize.js";

/** 描き手ひとり。いまは Codex だけ（定額の枠で描ける）。 */
export interface PainterConfig {
    readonly name: "codex";
    /** `default` なら契約の既定のモデル。道具を呼ぶだけなので軽いもので足りる。 */
    readonly model: string;
}

export function createPainter(entry: PainterConfig): Painter {
    if (entry.name === "codex") return new CodexPainter(entry.model);
    throw new Error(`描き手 ${String((entry as { name: unknown }).name)} は知らない。いま描けるのは codex だけ`);
}

/** 一枚の絵の頼み。企画が書く。 */
export interface Picture {
    /** env.images.<名前> の名前。 */
    readonly name: string;
    readonly prompt: string;
    readonly aspect: Aspect;
}

export interface Painted {
    readonly name: string;
    readonly path: string;
    readonly width: number;
    readonly height: number;
    readonly source: { readonly width: number; readonly height: number };
    /** 届いたままの画像。縮める前の絵を見たいとき用。台帳や作品には入れない。 */
    readonly raw: Uint8Array;
    readonly seconds: number;
    readonly log: CallLog;
}

export async function paintPicture(painter: Painter, ledger: Ledger, jobId: string, picture: Picture, workDir: string): Promise<Painted> {
    if (!IMAGE_NAME.test(picture.name)) throw new Error(`絵の名前 ${picture.name} は使えない（英小文字で始まる英小文字・数字・_）`);
    const started = performance.now();
    const painting = await callPainter(painter, ledger, jobId, `paint:${picture.name}`, { prompt: picture.prompt, aspect: picture.aspect });
    const image = normalize(painting.bytes);
    const dir = join(workDir, IMAGES_DIR);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${picture.name}.png`);
    writeFileSync(path, image.png);
    return {
        name: picture.name, path,
        width: image.width, height: image.height, source: image.source,
        raw: painting.bytes,
        seconds: (performance.now() - started) / 1000,
        log: painting.log
    };
}
