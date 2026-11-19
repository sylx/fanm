// 描いた絵を MSX の画面に落とした見本。fanm paint が、絵の隣に書き出す。
//
// 作品が普通にやること（この絵のための16色を選び、ディザで落として置く）を
// ヘッドレスのエンジンでやって撮る。描き手やプロンプトを試すとき、元の絵ではなく
// 画面でどう見えるかで判断できるように。

import { boot, type ScreenModeName } from "fantasy-msx";
import { readFrame } from "fantasy-msx/tools/capture.js";
import { encodePNG } from "fantasy-msx/tools/png.js";
import type { WorkImage } from "@fanm/work";

export function preview(image: WorkImage, mode: ScreenModeName = "G4"): Buffer {
    const runtime = boot();
    try {
        runtime.run({
            init({ screen, image: images }) {
                screen.setMode(mode);
                if (mode !== "G7") screen.setPalette(images.palette(image, { reserve: 1 }));
                images.drawNow(images.reduce(image, { width: screen.width, height: screen.height, fit: "cover", dither: "ordered" }));
            },
            update() {}
        });
        runtime.step();
        const frame = readFrame(runtime.bios.system.machine, runtime.screen.pixelAspect);
        return encodePNG(frame.pixels, frame.width, frame.height);
    } finally {
        runtime.stop();
    }
}
