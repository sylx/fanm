// 作品に同梱する画像。作品のディレクトリの images/<名前>.png が、そのまま
// env.images.<名前> になる（@fanm/work の WorkImage）。
//
// 検査（runner.ts、隔離した子プロセス）、作品庫への保存、公開物の組み立てが
// 同じ決まりで読む。ギャラリーのプレイヤーは meta.json の images を見て読む。
//
// 読むのは PNG だけ。エンジンのヘッドレスのデコーダ（tools/png.ts）が PNG しか
// 読めないので、ほかの形式は画像を作品に入れる前に PNG へ直しておく。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decodePNG } from "fantasy-msx/tools/png.js";
import { IMAGE_NAME, type WorkImage } from "@fanm/work";

export const IMAGES_DIR = "images";

/**
 * 一枚の上限。生成画像は 1〜2K 四方で届くが、画面は 512x212 が最大なので、
 * 作品に入れる前に縮めておく。縮め忘れた大きな画像で、検査のメモリと
 * 公開物の容量を食わないための歯止め。
 */
export const MAX_IMAGE_PIXELS = 1024 * 1024;

/** 作品のディレクトリにある画像の名前。名前順。画像の無い作品では空。 */
export function imageNames(dir: string): string[] {
    const images = join(dir, IMAGES_DIR);
    if (!existsSync(images)) return [];
    const names: string[] = [];
    for (const file of readdirSync(images).sort()) {
        const name = file.replace(/\.png$/, "");
        if (name === file) throw new Error(`${join(images, file)}: 画像は PNG だけ（images/<名前>.png）`);
        if (!IMAGE_NAME.test(name)) throw new Error(`${join(images, file)}: 名前は英小文字で始まる英小文字・数字・_（env.images.<名前> で引けるように）`);
        names.push(name);
    }
    return names;
}

/** 作品の画像を読んで、env.images に渡す形にする。 */
export function loadImages(dir: string): Record<string, WorkImage> {
    const images: Record<string, WorkImage> = {};
    for (const name of imageNames(dir)) {
        const path = join(dir, IMAGES_DIR, `${name}.png`);
        const image = decodePNG(new Uint8Array(readFileSync(path)));
        if (image.width * image.height > MAX_IMAGE_PIXELS) {
            throw new Error(`${path}: ${image.width}x${image.height} は大きすぎる（${MAX_IMAGE_PIXELS}画素まで）。作品に入れる前に縮める`);
        }
        images[name] = image;
    }
    return images;
}
