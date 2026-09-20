// 環境デモの実例。AIへ渡す形の見本であり、バッチとエンジンの結線確認にも使う。
//
// この型の勘どころは、毎フレーム何も描かないこと。星は init で一度置き、
// またたきはパレットの書き換えだけで作る。動くものはスプライトに任せる。
// 一度描いた絵は消えないので、動くものを blitter で描くと軌跡が残る。
//
// 状態はすべて factory の中に閉じ込め、起動のたびに作り直す。
// 時刻は frame、乱数は env.random だけを使う。

import { compile, opllVoice, psgVoice, type App, type Context } from "fantasy-msx";
import type { WorkFactory } from "@fanm/work";

/** またたきに使う色。ここを書き換えると、置いた星が一斉に変わる。 */
const TWINKLE = [4, 5, 6, 7];

const create: WorkFactory = env => {
    let frame = 0;

    // 星。色はまたたく4色のどれか。位置は seed で決まり、以後動かない。
    const stars = Array.from({ length: 120 }, () => ({
        x: Math.floor(env.random() * 256),
        y: Math.floor(env.random() * 146),
        color: TWINKLE[Math.floor(env.random() * TWINKLE.length)]
    }));

    // 雲。スプライトなので、動かすのに描画は要らない。
    const clouds = Array.from({ length: 4 }, (_, n) => ({
        x: Math.floor(env.random() * 256),
        y: 120 + n * 16,
        speed: 1 + n
    }));

    /** 流れ星。スプライトなので、通ったあとに何も残らない。 */
    let meteor: { x: number; y: number } | null = null;

    const theme = compile([
        { voice: psgVoice(0), mml: "t96 v9 q6 l8 o5 [c e g e  d f a f]2" },
        { voice: psgVoice(1), mml: "t96 v7 q7 l2 o3 [c f g c]" },
        { voice: opllVoice(0), mml: "t96 @6 v10 l1 o3 [c<a+>f g]" }
    ]);

    /** 空の色。上ほど暗く、水平線に向かって明るくなる帯を一度だけ描く。 */
    function sky({ screen, gfx }: Context): void {
        screen.setColor(0, 0, 0, 1);
        screen.setColor(1, 0, 0, 2);
        screen.setColor(2, 1, 0, 3);
        screen.setColor(3, 2, 1, 3);
        screen.setColor(8, 0, 1, 1);
        screen.setColor(9, 1, 2, 2);
        gfx.now.clear(0);
        for (let band = 0; band < 3; ++band) {
            gfx.now.fillRect(0, 100 + band * 16, 256, 16, band + 1);
        }
        gfx.now.fillRect(0, 148, 256, 64, 8);
        gfx.now.hline(0, 148, 256, 9);
    }

    const app: App = {
        init(ctx) {
            const { screen, gfx, sprites, bgm } = ctx;
            screen.setMode("G4");
            sky(ctx);
            for (const star of stars) gfx.now.pixel(star.x, star.y, star.color);

            sprites.setSize(16);
            sprites.setPatternFromBitmap(0, [
                "................", "................",
                "....######......", "..##########....",
                ".##############.", "################",
                ".##############.", "..##########....",
                "................", "................",
                "................", "................",
                "................", "................",
                "................", "................"
            ]);
            sprites.setPatternFromBitmap(4, [
                "...............#", "..............##",
                ".............##.", "............##..",
                "...........##...", "..........##....",
                ".........##.....", "........##......",
                ".......#........", "......#.........",
                ".....#..........", "....#...........",
                "................", "................",
                "................", "................"
            ]);
            clouds.forEach((cloud, n) => sprites.set(n, { x: cloud.x, y: cloud.y, pattern: 0, color: 9 }));
            sprites.set(clouds.length, { x: 0, y: 212, pattern: 4, color: 15 });
            sprites.setActiveCount(clouds.length + 1);

            bgm.play(theme, { loop: true });
        },

        update({ screen, sprites }) {
            frame++;

            // またたき。4色を順に明るくするだけで、120個の星が呼吸する。
            if (frame % 12 === 0) {
                const lit = (frame / 12) % TWINKLE.length;
                TWINKLE.forEach((color, n) => {
                    const level = n === lit ? 7 : 3 + (n % 2);
                    screen.setColor(color, level, level, 7);
                });
            }

            clouds.forEach((cloud, n) => {
                cloud.x = (cloud.x + cloud.speed) % 288;
                sprites.move(n, cloud.x - 16, cloud.y);
            });

            if (!meteor && frame % 300 === 120) {
                meteor = { x: Math.floor(env.random() * 180), y: -16 - Math.floor(env.random() * 20) };
            }
            if (meteor) {
                meteor.x += 3;
                meteor.y += 2;
                if (meteor.y > 96) meteor = null;
            }
            // スプライトは画面の外へ置けば消える。消すための描画は要らない。
            sprites.move(clouds.length, meteor ? meteor.x : 0, meteor ? meteor.y : 212);
        },

        draw({ gfx }) {
            // 水面のきらめき。60フレームに一度、点をひとつ置くだけ。
            if (frame % 30 !== 0 || gfx.pending > 2) return;
            const x = Math.floor(env.random() * 256);
            const y = 150 + Math.floor(env.random() * 58);
            gfx.now.hline(x, y, 3, (frame / 30) % 6 === 0 ? 9 : 8);
        }
    };
    return app;
};

export default create;
