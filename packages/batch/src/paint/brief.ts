// 生成の頼みに入れる「同梱の画像」の節（D部門）。
//
// コードを書く相手は絵を見られない。分かるのは、企画が描き手に渡した文（どこに
// 何があるか）と、ここで渡す数字だけ。
//
// 数字のうち一番効くのはパレット。image.palette の選び方は決まっていて、同じ絵なら
// 毎回同じ色が同じ番号に並ぶ。だから、光らせる色・回す色を番号で選べるように、
// 作品が普通に呼ぶ形（G4、reserve: 1）で実際に選ばせて並べる。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boot, type PaletteColor } from "fantasy-msx";
import { decodePNG } from "fantasy-msx/tools/png.js";
import { IMAGES_DIR } from "../check/images.js";
import type { Picture } from "./paint.js";

/** 3ビットの色を、明るさと大まかな色味の言葉にする。番号を選ぶ手がかり。 */
function describe([r, g, b]: PaletteColor): string {
    // 重みは緑 4、赤 2、青 3（エンジンが色を比べる重み）。白 [7, 7, 7] が 63。
    const light = r * 2 + g * 4 + b * 3;
    if (light < 6) return "黒";
    const level = light >= 38 ? "明るい" : light >= 18 ? "中くらいの" : "暗い";
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min <= 1) return `${level}灰色`;
    const hue = r >= g && r >= b ? (g >= b + 2 ? "黄〜橙" : b >= g + 2 ? "赤紫" : "赤")
        : g >= r && g >= b ? (r >= b + 2 ? "黄緑" : b >= r + 2 ? "青緑" : "緑")
            : (r >= g + 2 ? "紫" : g >= r + 2 ? "水色" : "青");
    return `${level}${hue}`;
}

/** この絵に image.palette(..., { reserve: 1 }) が返す16色。G4 で選ぶ。 */
function chosenPalette(path: string): { width: number; height: number; colors: PaletteColor[] } {
    const source = decodePNG(new Uint8Array(readFileSync(path)));
    const runtime = boot();
    try {
        const colors = runtime.bios.image.palette(source, { reserve: 1, mode: "G4" });
        return { width: source.width, height: source.height, colors };
    } finally {
        runtime.stop();
    }
}

/** 生成の頼みの「同梱の画像」の節。絵の無い作品では空文字。 */
export function picturesBrief(pictures: readonly Picture[] | undefined, jobDir: string): string {
    if (!pictures?.length) return "";
    const parts = pictures.map(picture => {
        const { width, height, colors } = chosenPalette(join(jobDir, IMAGES_DIR, `${picture.name}.png`));
        const palette = colors
            .map((c, i) => `  ${String(i).padStart(2)}: [${c.join(", ")}] ${i === 0 ? "（reserve で残した今の色）" : describe(c)}`)
            .join("\n");
        return [
            `### env.images.${picture.name}（${width}x${height}）`,
            "",
            "描き手に渡した文:",
            "",
            `> ${picture.prompt}`,
            "",
            `\`image.palette(env.images.${picture.name}, { reserve: 1 })\` は G4 で次の16色を返す（[r, g, b] は各 0〜7）。`,
            "reserve の数や mode を変えると選ばれる色も並びも変わる。",
            "",
            "```",
            palette,
            "```"
        ].join("\n");
    });
    return [
        "## 同梱の画像",
        "",
        "この作品には次の絵が同梱されています。`env.images.<名前>` で受け取り、型の手引きの「絵を使う」のとおりに画面に落としてください。",
        "絵そのものは見られません。何がどこにあるかは描き手に渡した文から、どの色が何番かは下の表から判断してください。",
        "",
        ...parts
    ].join("\n");
}
