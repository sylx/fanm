// 描いてもらった絵を、作品に同梱する形にする（D部門）。
//
// 生成画像は 1〜2K 四方、1MB を超えて届く。画面は最大でも 512x212（G5/G6、
// 縦長の画素）なので、そのまま持つと検査のメモリと公開物の容量を食うだけ。
// 512x424 の枠に収まるまで縮めて、PNG で書き直す。
//
// 縮めすぎない。減色（ctx.image.reduce）はこの絵を画面の大きさへもう一度
// 縮めながら色を選ぶので、そのときに平均を取れるだけの画素を残しておく。
//
// 書き直した PNG には色の補正の情報（gAMA、iCCP）を入れない。検査はバッチが
// 画素をそのまま読み、ギャラリーのプレイヤーも補正を切って読む。両方で同じ
// 画素から減色するため。

import { decodePNG, encodePNG } from "fantasy-msx/tools/png.js";
import type { WorkImage } from "@fanm/work";
import { MAX_IMAGE_PIXELS } from "../check/images.js";
import { sniff } from "../providers/painter.js";

/** 縮めた先の枠。512 は G5/G6 の横、424 は 212 行の二倍（縦長の画素で縦横比を保つのに要る）。 */
export const FRAME = { width: 512, height: 424 } as const;

export interface Normalized {
    /** 作品の images/<名前>.png に置く中身。 */
    readonly png: Buffer;
    readonly width: number;
    readonly height: number;
    /** 届いたときの大きさ。 */
    readonly source: { readonly width: number; readonly height: number };
}

export function normalize(bytes: Uint8Array): Normalized {
    const source = decode(bytes);
    const scale = Math.min(1, FRAME.width / source.width, FRAME.height / source.height);
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    if (width * height > MAX_IMAGE_PIXELS) throw new Error(`縮めても ${width}x${height} あって大きすぎる`);
    const pixels = scale < 1 ? shrink(source, width, height) : new Uint8Array(source.data);
    return {
        png: encodePNG(new Uint32Array(pixels.buffer, pixels.byteOffset, width * height), width, height),
        width, height,
        source: { width: source.width, height: source.height }
    };
}

function decode(bytes: Uint8Array): WorkImage {
    const mime = sniff(bytes);
    if (mime === "image/png") return decodePNG(bytes);
    // TODO: Gemini は JPEG で返してくる。読むには JPEG のデコーダ（jpeg-js など）を依存に足す。
    if (mime === "image/jpeg") throw new Error("JPEG はまだ読めない。PNG で描く相手（Codex）を使う");
    throw new Error("PNG でも JPEG でもないものが届いた");
}

/**
 * 面積平均で縮める。行き先の一画素が覆う元の範囲を、端の欠けた画素は覆った
 * 割合だけ重みを付けて平均する。ドット絵風の生成画像でも、ドットの境目で
 * 色が飛ばず、なだらかに混ざる（色を選び直すのは減色の役目）。
 */
function shrink(source: WorkImage, width: number, height: number): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    const sx = source.width / width;
    const sy = source.height / height;
    const sum = new Float64Array(4);
    for (let y = 0; y < height; ++y) {
        const y0 = y * sy, y1 = y0 + sy;
        for (let x = 0; x < width; ++x) {
            const x0 = x * sx, x1 = x0 + sx;
            sum.fill(0);
            let weight = 0;
            for (let v = Math.floor(y0); v < Math.min(source.height, Math.ceil(y1)); ++v) {
                const wy = Math.min(v + 1, y1) - Math.max(v, y0);
                for (let u = Math.floor(x0); u < Math.min(source.width, Math.ceil(x1)); ++u) {
                    const w = wy * (Math.min(u + 1, x1) - Math.max(u, x0));
                    const p = (v * source.width + u) * 4;
                    for (let c = 0; c < 4; ++c) sum[c] += source.data[p + c] * w;
                    weight += w;
                }
            }
            const q = (y * width + x) * 4;
            for (let c = 0; c < 4; ++c) out[q + c] = Math.round(sum[c] / weight);
        }
    }
    return out;
}
