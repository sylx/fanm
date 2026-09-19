// 最小の作品。AIへ渡す実例であり、バッチとエンジンの結線確認にも使う。
//
// 状態はすべて factory の中に閉じ込め、起動のたびに作り直す。
// 時刻は frame、乱数は env.random だけを使う。

import type { App } from "fantasy-msx";
import type { WorkFactory } from "@fanm/work";

const create: WorkFactory = env => {
    let frame = 0;
    const stars = Array.from({ length: 24 }, () => ({
        x: Math.floor(env.random() * 256),
        y: Math.floor(env.random() * 212),
        color: 2 + Math.floor(env.random() * 14)
    }));

    const app: App = {
        init({ gfx }) {
            gfx.now.clear(1);
            gfx.now.text(88, 100, "FANM", 15);
        },
        update() {
            frame++;
        },
        draw({ gfx }) {
            if (frame % 30 !== 0) return;
            const star = stars[(frame / 30) % stars.length];
            gfx.fillCircle(star.x, star.y, 4 + (frame / 30) % 12, star.color);
        }
    };
    return app;
};

export default create;
