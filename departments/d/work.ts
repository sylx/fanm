// D部門の実例。生成した画像を同梱し、それを MSX の画面に落として見せる。
//
// 画像は env.images で届く（images/castle.png → env.images.castle）。色は
// 減らしていない RGBA なので、ctx.image で画面のモードに合わせて減らす。
//
//   1. image.palette で、この絵のための16色を選ぶ（0番は黒のまま残す）
//   2. image.reduce で、その16色とディザで 256x212 に落とす
//   3. image.drawNow で VRAM に一度だけ置く
//
// 置いた絵は描き直さない。動きはパレットの書き換えとスプライトで作る。
// 画面ごと描き直すと blitter が追いつかない。
//
// 画像は自分で読みに行かない（fetch も image.load も使えない）。

import { compile, opllVoice, psgVoice, type App, type PaletteColor } from "fantasy-msx";
import type { WorkFactory } from "@fanm/work";

/** 絵が闇から浮かぶまでのフレーム数。 */
const FADE = 180;

const create: WorkFactory = env => {
    let frame = 0;
    /** この絵のために選んだ16色。フェードと明滅は、ここから計算し直す。 */
    let colors: PaletteColor[] = [];
    /** 灯りの色（赤と緑が強く、青が弱い）。ここだけを揺らす。 */
    let lamp = 0;
    /** 影の色（いちばん暗い色）。蝙蝠に使う。 */
    let shadow = 0;

    /** 蝙蝠。スプライトなので、絵を壊さずに飛ばせる。 */
    const bat = { x: -16, y: 60, phase: env.random() * Math.PI * 2 };

    const theme = compile([
        { voice: opllVoice(0), mml: "t72 @11 v10 l2 o3 [a e f e]" },
        { voice: psgVoice(0), mml: "t72 v8 q5 l8 o5 [r4 a>c<b a e4 r4  r4 f a g f e4 r4]" },
        { voice: psgVoice(1), mml: "t72 v6 l1 o2 [a f]" }
    ]);

    /** 0番を除いた中で score がいちばん高い色の番号。 */
    function pick(score: (color: PaletteColor) => number): number {
        let best = 1;
        for (let i = 2; i < colors.length; ++i) if (score(colors[i]) > score(colors[best])) best = i;
        return best;
    }

    /** 選んだ色を、明るさ t（0〜1）で画面に出す。lift は灯りだけの上乗せ。 */
    function shade(screen: { setColor(i: number, r: number, g: number, b: number): void }, t: number, lift = 0): void {
        colors.forEach(([r, g, b], i) => {
            const k = i === lamp ? Math.min(1, t + lift) : t;
            screen.setColor(i, Math.round(r * k), Math.round(g * k), Math.round(b * k));
        });
    }

    const app: App = {
        init({ screen, image, sprites, bgm }) {
            screen.setMode("G4");
            const source = env.images.castle;

            // 0番は黒のまま（周りの枠と、まだ浮かんでいない闇の色）。
            colors = image.palette(source, { reserve: 1 });
            colors[0] = [0, 0, 0];
            lamp = pick(([r, g, b]) => r + g - 2 * b);
            shadow = pick(([r, g, b]) => -(r + g + b));

            const picture = image.reduce(source, {
                width: screen.width, height: screen.height, fit: "cover",
                palette: colors, exclude: [0], dither: "ordered"
            });
            shade(screen, 0);
            image.drawNow(picture, 0, 0);

            sprites.setSize(16);
            sprites.setPatternFromBitmap(0, [
                "................", "................",
                "................", "#......##......#",
                "##....####....##", ".###..####..###.",
                "..############..", "...##########...",
                "....##.##.##....", "................",
                "................", "................",
                "................", "................",
                "................", "................"
            ]);
            sprites.set(0, { x: bat.x, y: 212, pattern: 0, color: shadow });
            sprites.setActiveCount(1);

            bgm.play(theme, { loop: true });
        },

        update({ screen, sprites }) {
            frame++;

            if (frame <= FADE) {
                // 闇から浮かぶ。始めはゆっくり、終わりは速く。
                const t = frame / FADE;
                shade(screen, t * t);
            } else if (frame % 6 === 0) {
                // 灯りの揺らぎ。一色だけを書き換えれば、窓という窓が一斉に揺れる。
                shade(screen, 1, 0.15 * Math.sin(frame / 7) + 0.1 * env.random() - 0.1);
            }

            // 蝙蝠は絵が浮かんでから、月の前を横切る。
            if (frame > FADE) {
                bat.x += 1;
                if (bat.x > 272) bat.x = -16 - Math.floor(env.random() * 120);
                const y = bat.y + Math.round(8 * Math.sin(bat.x / 12 + bat.phase));
                sprites.move(0, bat.x, y);
            }
        }
    };
    return app;
};

export default create;
