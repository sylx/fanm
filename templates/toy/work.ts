// おもちゃの実例。円の中に線を引くと、八方に写って模様になる。
//
// この型で外してはいけないのは三つ。
//
//   1. 勝ち負けも点数も無い。触ると何かが起き、触り続けると何かが溜まる。
//   2. 誰も触らなければ、見えない手（hand）が自分で遊ぶ。人が触ったら手を引っ込め、
//      10秒放っておかれたらまた出てくる。人の手と見えない手は同じ道具を使う
//      （どちらも cursor と pen を動かすだけ）。
//   3. 毎フレームの仕事は小さく。線は 2x2 の塗りを八つ置くだけで、描いたら消えない。
//      色が揺れて見えるのは、インクの8色をパレットで回しているから。
//
// 円がいっぱいになったら（または B で）、円を一つ塗りつぶして片づける。
// その塗りは blitter が数フレームかけて進めるので、消えていくのが見える。

import { BUTTON, compile, opllVoice, psgVoice, type App, type Context } from "fantasy-msx";
import type { WorkFactory } from "@fanm/work";

const CX = 128;
const CY = 104;
const RADIUS = 96;
const INK = 2;               // インクは 2〜9 の8色
const INKS = 8;
const FULL = 900;            // これだけ描いたら片づける（ペンを下ろしていたフレーム数）
const IDLE = 600;

/** 色の組。片づけるたびに次の組へ。一組 8 色、[r, g, b] は 0〜7。 */
const SCHEMES: readonly (readonly (readonly [number, number, number])[])[] = [
    [[7, 2, 2], [7, 4, 1], [7, 6, 1], [5, 7, 1], [1, 7, 3], [1, 6, 7], [3, 3, 7], [6, 2, 7]],
    [[1, 2, 5], [1, 3, 6], [2, 4, 7], [3, 5, 7], [4, 6, 7], [6, 7, 7], [4, 6, 7], [2, 4, 7]],
    [[6, 5, 3], [7, 6, 4], [7, 7, 5], [6, 4, 2], [4, 2, 1], [5, 3, 1], [7, 5, 2], [7, 7, 6]]
];

/** ペンの音。円の中心から遠いほど高い。五音の音階だけを使う。 */
const SCALE = ["c", "d", "e", "g", "a"] as const;

const create: WorkFactory = env => {
    let frame = 0;
    const cursor = { x: 40, y: 0 };      // 円の中心からの位置
    let pen = false;
    let ink = 0;                         // 今のインク（0〜7）
    let filled = 0;
    let scheme = 0;
    let clearing = false;
    let wiping = false;                  // 片づけの塗りを積んだか
    let human = false;
    let idle = 0;

    // 見えない手。バラの曲線をなぞり、ときどきペンを上げる。片づけるたびに形を変える。
    const hand = { angle: 0, petals: 3, turn: 0.02, size: 0.8, down: 120, up: 0 };

    const theme = compile([
        { voice: opllVoice(0), mml: "t80 @8 v12 l1 o3 [c < a > d < g]" },
        { voice: opllVoice(1), mml: "t80 @8 v13 l1 o4 [e c f d]" },
        { voice: psgVoice(0), mml: "t80 v6 q8 l2 o5 [g e a f g d g b]" }
    ]);

    function reshape(): void {
        hand.petals = [2, 3, 5, 7][Math.floor(env.random() * 4)];
        hand.size = 0.55 + env.random() * 0.4;
        // 花びらが多いほどゆっくり回す。速すぎると手が曲線に追いつかない。
        hand.turn = (1.5 + env.random() * 1.5) / (RADIUS * hand.size * hand.petals);
        hand.angle = env.random() * Math.PI * 2;
    }

    function inkColors({ screen }: Context): void {
        // 8色を一つずらして入れ直す。描いた点は動かず、色だけが流れる。
        const colors = SCHEMES[scheme];
        for (let n = 0; n < INKS; ++n) {
            const [r, g, b] = colors[(n + (frame >> 3)) % INKS];
            screen.setColor(INK + n, r, g, b);
        }
    }

    function ring({ screen, gfx }: Context): void {
        screen.setColor(0, 0, 0, 0);
        screen.setColor(1, 2, 2, 3);
        screen.setColor(14, 3, 3, 4);
        screen.setColor(15, 7, 7, 7);
        gfx.now.clear(0);
        gfx.now.circle(CX, CY, RADIUS + 4, 1);
        gfx.now.circle(CX, CY, RADIUS + 6, 1);
    }

    /** 見えない手の一歩。行きたい場所へ、人の手と同じ速さで寄る。 */
    function autopilot(): { x: number; y: number; pen: boolean } {
        hand.angle += hand.turn;
        const r = RADIUS * hand.size * Math.abs(Math.cos(hand.petals * hand.angle));
        const goal = { x: r * Math.cos(hand.angle), y: r * Math.sin(hand.angle) };
        if (hand.down > 0 && --hand.down === 0) hand.up = 20 + Math.floor(env.random() * 50);
        else if (hand.up > 0 && --hand.up === 0) hand.down = 90 + Math.floor(env.random() * 150);
        return { x: Math.sign(Math.round(goal.x - cursor.x)), y: Math.sign(Math.round(goal.y - cursor.y)), pen: hand.down > 0 };
    }

    /** 八方に写して置く。座標は偶数にそろえると blitter が速い。 */
    function plot({ gfx }: Context): void {
        const x = Math.round(cursor.x);
        const y = Math.round(cursor.y);
        const color = INK + ink;
        for (const [a, b] of [[x, y], [y, x]]) {
            for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
                gfx.now.fillRect((CX + sx * a) & ~1, (CY + sy * b) & ~1, 2, 2, color);
            }
        }
    }

    function mirrors({ sprites }: Context): void {
        const x = Math.round(cursor.x);
        const y = Math.round(cursor.y);
        const spots = [[x, y], [-x, y], [x, -y], [-x, -y], [y, x], [-y, x], [y, -x], [-y, -x]];
        spots.forEach(([sx, sy], n) => sprites.move(n, CX + sx - 3, CY + sy - 3));
    }

    const app: App = {
        init(ctx) {
            const { screen, sprites, bgm } = ctx;
            screen.setMode("G4");
            ring(ctx);
            inkColors(ctx);
            reshape();

            sprites.setSize(8);
            sprites.setPatternFromBitmap(0, [
                "...#....", "...#....", "........", "##.#.##.",
                "........", "...#....", "...#....", "........"
            ]);
            for (let n = 0; n < 8; ++n) sprites.set(n, { x: 0, y: 212, pattern: 0, color: n === 0 ? 15 : 14 });
            sprites.setActiveCount(8);
            mirrors(ctx);

            bgm.play(theme, { loop: true });
        },

        update(ctx) {
            const { input, gfx, bgm } = ctx;
            frame++;
            if (frame % 8 === 0) inkColors(ctx);

            const axis = input.axis();
            const touched = axis.x !== 0 || axis.y !== 0 || input.btn(BUTTON.A) || input.btn(BUTTON.B);
            if (touched) {
                human = true;
                idle = 0;
            } else if (human && ++idle > IDLE) {
                human = false;
            }

            if (clearing) {
                // 片づけの塗りが終わるまで、手は止めておく。
                if (wiping && !gfx.busy) {
                    clearing = false;
                    wiping = false;
                    filled = 0;
                    scheme = (scheme + 1) % SCHEMES.length;
                    reshape();
                }
                return;
            }

            const move = human ? { x: axis.x, y: axis.y, pen: input.btn(BUTTON.A) } : autopilot();
            const speed = human ? 2 : 1.5;
            const nx = cursor.x + move.x * speed;
            const ny = cursor.y + move.y * speed;
            if (nx * nx + ny * ny < (RADIUS - 2) * (RADIUS - 2)) {
                cursor.x = nx;
                cursor.y = ny;
            }
            mirrors(ctx);

            pen = move.pen;
            if (pen) {
                filled++;
                if (filled % 40 === 0) ink = (ink + 1) % INKS;
                // 音はペンを下ろしているあいだ、8フレームに一度。高さは中心からの距離。
                if (frame % 8 === 0) {
                    const reach = Math.hypot(cursor.x, cursor.y) / RADIUS;
                    const step = Math.min(SCALE.length * 2 - 1, Math.floor(reach * SCALE.length * 2));
                    bgm.effect(psgVoice(2), `t120 v10 l32 o${4 + (step >= SCALE.length ? 1 : 0)} ${SCALE[step % SCALE.length]}`);
                }
            }
            if (filled >= FULL || (human && input.btnp(BUTTON.B))) clearing = true;
        },

        draw(ctx) {
            const { gfx } = ctx;
            if (clearing) {
                // 一度だけ積む。半径96の円は blitter で10フレームほどかかる。
                if (!wiping) gfx.fillCircle(CX, CY, RADIUS, 0);
                wiping = true;
                return;
            }
            if (pen) plot(ctx);
        }
    };
    return app;
};

export default create;
