// 操作できるゲームの実例。落ちてくる実を受け、石を避ける。
//
// この型で外してはいけないのは二つ。
//
//   1. 誰も触らなくても遊びが進むこと。最初は機械が自分で遊ぶ（demo）。
//      入力が来たら人へ渡し、しばらく触られなければまた機械へ戻す。
//   2. 動くものをすべてスプライトに置くこと。背景は init で一度描き、
//      以後 blitter を使うのは点数が変わったときの一行だけ。
//
// 当たり判定は自分の座標で取る。sprites.collided() は1フレームに一度しか
// 読めず、どれとどれが当たったかも分からない。

import { BUTTON, compile, opllVoice, psgVoice, type App, type Context } from "fantasy-msx";
import type { WorkFactory } from "@fanm/work";

const GROUND = 176;          // 主人公の足が乗る高さ
const PLAYER_Y = GROUND - 16;
const FALLERS = 6;           // 同時に落ちてくる数。スプライトは32枚まで
const SPRITE_PLAYER = 0;     // スプライト0番は主人公。1番から落ちるもの

/** 落ちてくるもの。実は点、石は当たると残機が減る。 */
interface Faller {
    x: number;
    y: number;
    speed: number;
    kind: "seed" | "rock";
    alive: boolean;
}

const create: WorkFactory = env => {
    let frame = 0;
    let score = 0;
    let lives = 3;
    let shown = { score: -1, lives: -1 };   // 最後に描いた値。変わったときだけ描き直す
    let over = 0;                           // 0 より大きいと、やり直しまでの残りフレーム
    let demo = true;                        // 機械が遊んでいるか
    let idle = 0;                           // 最後に人が触ってからのフレーム数

    let player = { x: 120, vx: 0 };
    const fallers: Faller[] = Array.from({ length: FALLERS }, () => ({
        x: 0, y: -32, speed: 1, kind: "seed", alive: false
    }));

    const theme = compile([
        { voice: psgVoice(0), mml: "t140 v10 q6 l8 o5 [ceg> c<gec]2 [dfa>d<afd]2" },
        { voice: psgVoice(1), mml: "t140 v8 q7 l4 o3 [c c g g]2 [d d a a]2" },
        { voice: opllVoice(0), mml: "t140 @14 v10 l2 o3 [c e]2 [d f]2" }
    ]);

    function spawn(faller: Faller): void {
        faller.x = 8 + Math.floor(env.random() * 224);
        faller.y = -16 - Math.floor(env.random() * 48);
        faller.speed = 1 + Math.floor(env.random() * 3);
        faller.kind = env.random() < 0.3 ? "rock" : "seed";
        faller.alive = true;
    }

    /** 点数の行。変わったときだけ描く。gfx.now なので待たずに出る。 */
    function hud({ gfx }: Context): void {
        if (shown.score === score && shown.lives === lives) return;
        gfx.now.fillRect(0, 0, 256, 10, 0);
        gfx.now.text(4, 1, `SCORE ${String(score).padStart(5, "0")}`, 15);
        gfx.now.text(160, 1, `LIFE ${"#".repeat(Math.max(0, lives))}`, 8);
        shown = { score, lives };
    }

    function field({ screen, gfx }: Context): void {
        screen.setColor(0, 0, 0, 1);
        screen.setColor(1, 1, 1, 3);
        screen.setColor(2, 0, 2, 1);
        screen.setColor(3, 0, 4, 2);
        gfx.now.clear(0);
        // 遠くの丘。init で一度だけ。
        for (let x = 0; x < 256; x += 16) {
            const height = 24 + ((x * 7) % 5) * 6;
            gfx.now.fillRect(x, GROUND - height, 16, height, 1);
        }
        gfx.now.fillRect(0, GROUND, 256, 212 - GROUND, 2);
        gfx.now.hline(0, GROUND, 256, 3);
    }

    function reset(): void {
        score = 0;
        lives = 3;
        over = 0;
        player = { x: 120, vx: 0 };
        for (const faller of fallers) faller.alive = false;
    }

    /**
     * 機械の手。落ちてくるものを「あと何フレームで届くか」で見る。
     *
     * 石が降ってくる場所を危ないところとし、そこには入らない。危なくない実の
     * うち、一番早く届くものの下へ寄る。人が遊んでいるように見えればよく、
     * うまい必要はない。
     */
    function autopilot(): number {
        const risky = (x: number) => fallers.some(faller => faller.alive && faller.kind === "rock"
            && (PLAYER_Y - faller.y) / faller.speed < 30 && Math.abs(faller.x - x) < 22);

        let target: number | null = null;
        let soonest = 1e9;
        for (const faller of fallers) {
            if (!faller.alive || faller.kind !== "seed") continue;
            const eta = (PLAYER_Y - faller.y) / faller.speed;
            if (eta >= 0 && eta < soonest && !risky(faller.x)) {
                soonest = eta;
                target = faller.x;
            }
        }
        if (risky(player.x)) return risky(player.x - 24) ? 1 : -1;      // 今いる場所が危ない
        if (target === null || Math.abs(target - player.x) < 3) return 0;
        const step = target < player.x ? -1 : 1;
        return risky(player.x + step * 20) ? 0 : step;                  // 寄る先が危ないなら待つ
    }

    const app: App = {
        init(ctx) {
            const { screen, sprites, bgm } = ctx;
            screen.setMode("G4");
            field(ctx);
            hud(ctx);

            sprites.setSize(16);
            sprites.setPatternFromBitmap(0, [                    // 主人公。籠をかかえた人
                "................", ".....######.....",
                "....########....", "....##....##....",
                "....########....", ".....######.....",
                "......####......", "....########....",
                "...##########...", "..####....####..",
                "..###......###..", "..############..",
                "..############..", "...##########...",
                "....##....##....", "....##....##...."
            ]);
            sprites.setPatternFromBitmap(4, [                    // 実
                "................", "................",
                "......####......", ".....######.....",
                "....########....", "....########....",
                "....########....", ".....######.....",
                "......####......", "................",
                "................", "................",
                "................", "................",
                "................", "................"
            ]);
            sprites.setPatternFromBitmap(8, [                    // 石
                "................", "................",
                "....######......", "...########.....",
                "..##########....", "..##########....",
                "...########.....", "....######......",
                "................", "................",
                "................", "................",
                "................", "................",
                "................", "................"
            ]);
            sprites.set(SPRITE_PLAYER, { x: player.x, y: PLAYER_Y, pattern: 0, color: 15 });
            fallers.forEach((_, n) => sprites.set(SPRITE_PLAYER + 1 + n, { x: 0, y: 212, pattern: 4, color: 10 }));
            sprites.setActiveCount(1 + FALLERS);

            bgm.play(theme, { loop: true });
        },

        update(ctx) {
            const { input, sprites, bgm } = ctx;
            frame++;

            // 人が触ったか。触られたら機械の手を止め、10秒放っておかれたら戻す。
            const axis = input.axis();
            const touched = axis.x !== 0 || input.btn(BUTTON.A) || input.btn(BUTTON.B);
            if (touched) {
                demo = false;
                idle = 0;
            } else if (!demo && ++idle > 600) {
                demo = true;
            }

            if (over > 0) {
                // 終わったあとは少し見せてから、勝手にやり直す。
                if (--over === 0) {
                    reset();
                    field(ctx);
                    hud(ctx);
                }
                return;
            }

            const move = demo ? autopilot() : axis.x;
            player.vx = move * 3;
            player.x = Math.max(0, Math.min(240, player.x + player.vx));
            sprites.move(SPRITE_PLAYER, player.x, PLAYER_Y);

            for (let n = 0; n < fallers.length; ++n) {
                const faller = fallers[n];
                if (!faller.alive) {
                    if (frame % 24 === n * 4) spawn(faller);
                    continue;
                }
                faller.y += faller.speed;

                // 主人公の籠（上半分だけ当たる）に触れたか。
                const caught = faller.y + 12 > PLAYER_Y && faller.y < PLAYER_Y + 14
                    && faller.x + 12 > player.x && faller.x < player.x + 14;
                if (caught) {
                    faller.alive = false;
                    if (faller.kind === "seed") {
                        score += 10;
                        bgm.effect(psgVoice(2), "t140 v13 l32 o6 ceg>c");
                    } else {
                        lives--;
                        bgm.effect(psgVoice(2), "t140 v14 w16 l16 o3 c");
                    }
                } else if (faller.y > 212) {
                    faller.alive = false;
                }

                sprites.set(SPRITE_PLAYER + 1 + n, {
                    x: faller.alive ? faller.x : 0,
                    y: faller.alive ? faller.y : 212,
                    pattern: faller.kind === "seed" ? 4 : 8,
                    color: faller.kind === "seed" ? 10 : 14
                });
            }

            if (lives <= 0) over = 180;
            hud(ctx);
        },

        draw({ gfx }) {
            // 終わりの札だけ、そのとき一度描く。ふだんは何も積まない。
            if (over === 179) {
                gfx.now.fillRect(72, 96, 112, 24, 0);
                gfx.now.rect(72, 96, 112, 24, 15);
                gfx.now.text(88, 104, "GAME OVER", 15);
            }
        }
    };
    return app;
};

export default create;
