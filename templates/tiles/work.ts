// キャラクタ画面（SCREEN 4 = G3）の実例。土を掘って宝石を集める。掘った穴には
// 泉から水が染みてくる。
//
// この型で外してはいけないのは三つ。
//
//   1. 画面は毎フレーム丸ごと作り直す。NameBuffer（768バイトの名前表の写し）を
//      消して、地図と点数を書き込み、tiles.transfer で一度に送る。blitter を
//      使わないので、全部描き直しても何も待たない。gfx はこのモードでは使えない。
//   2. 動く絵はキャラクタの定義を書き換えて作る。水はどこに何マスあっても同じ
//      一文字なので、その文字の8バイトを書き換えれば全部が一度に波打つ。
//   3. 地図と画面は同じもの。当たり判定は地図の文字コードを見る。
//
// 掘る人は8x8の多色スプライト（2枚重ね）。G3 のスプライトは MSX2 のものなので
// 多色にできる。G1 / G2 では一色だけ。

import { BUTTON, NameBuffer, compile, opllVoice, psgVoice, type App, type Context, type MulticolorPattern } from "fantasy-msx";
import type { WorkFactory } from "@fanm/work";

const COLUMNS = 32;
const FIELD_TOP = 1;                 // 0行目は点数、23行目は案内。地図はその間
const FIELD_ROWS = 22;
const SURFACE = 2;                   // 地図の中の地表の行。その上は空
const GEMS = 8;
const STEP = 6;                      // 空いたマスを一つ進むフレーム数
const DIG = 12;                      // 土を掘って進むフレーム数
const SPRITE_DIGGER = 0;             // 多色なので 0 と 1 を使う

// 文字コード。32〜126 は内蔵フォント。地図の文字は128から。
const EMPTY = 32, TOPSOIL = 128, SOIL = 129, ROCK = 130, GEM = 131, WATER = 132, SPRING = 133;

/** 16色。0 は透明（背景色が透ける）。12|3 = 15 は掘る人の兜の光に使う。 */
const PALETTE: [number, number, number][] = [
    [0, 0, 0], [0, 0, 1], [2, 1, 0], [4, 2, 1],
    [1, 4, 1], [3, 3, 4], [5, 5, 6], [0, 2, 5],
    [3, 5, 7], [6, 1, 4], [7, 4, 7], [7, 7, 5],
    [7, 6, 0], [2, 3, 6], [4, 4, 5], [7, 7, 7]
];

const create: WorkFactory = env => {
    let frame = 0;
    let score = 0;
    let lives = 3;
    let level = 1;
    let left = GEMS;
    let over = 0;                    // 0 より大きいと、やり直しまでの残りフレーム
    let pause = 0;                   // 面の切り替えや失敗のあとの間
    let demo = true;
    let idle = 0;

    /** 地図。これがそのまま画面の地図の部分になる。 */
    const world = new NameBuffer(COLUMNS, FIELD_ROWS);
    /** 毎フレーム作り直す画面。 */
    const screenBuffer = new NameBuffer();

    // 掘る人。cx, cy は今いるマス、tx, ty は向かっているマス、t は進んだフレーム数。
    let digger = { cx: 16, cy: 1, tx: 16, ty: 1, t: 0, span: STEP };
    let standing: MulticolorPattern;
    let stepping: MulticolorPattern;

    const theme = compile([
        { voice: psgVoice(0), mml: "t120 v10 q5 l8 o4 [a>c<ae a>c<ag]2 [f>c<fa g>d<gb]2" },
        { voice: psgVoice(1), mml: "t120 v9 q6 l4 o2 [a a e e]2 [f f g g]2" },
        { voice: opllVoice(0), mml: "t120 @12 v11 l1 o3 [a e]2 [f g]2" }
    ]);

    function newMap(): void {
        world.clear(EMPTY);
        world.fill(0, SURFACE, COLUMNS, 1, TOPSOIL);
        world.fill(0, SURFACE + 1, COLUMNS, FIELD_ROWS - SURFACE - 1, SOIL);
        for (let y = SURFACE + 2; y < FIELD_ROWS; ++y) {
            for (let x = 0; x < COLUMNS; ++x) if (env.random() < 0.12) world.put(x, y, ROCK);
        }
        for (let n = 0; n < level; ++n) {
            world.put(2 + Math.floor(env.random() * 28), SURFACE + 3 + Math.floor(env.random() * 14), SPRING);
        }
        left = 0;
        while (left < GEMS) {
            const x = Math.floor(env.random() * COLUMNS), y = SURFACE + 2 + Math.floor(env.random() * (FIELD_ROWS - SURFACE - 2));
            if (world.get(x, y) !== SOIL) continue;
            world.put(x, y, GEM);
            left++;
        }
        digger = { cx: 16, cy: SURFACE - 1, tx: 16, ty: SURFACE - 1, t: 0, span: STEP };
    }

    function reset(): void {
        score = 0;
        lives = 3;
        level = 1;
        over = 0;
        newMap();
    }

    function passable(code: number): boolean {
        return code !== ROCK && code !== WATER && code !== SPRING;
    }

    function inside(x: number, y: number): boolean {
        return x >= 0 && x < COLUMNS && y >= 0 && y < FIELD_ROWS;
    }

    function nearWater(x: number, y: number): boolean {
        return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => inside(x + dx, y + dy) && world.get(x + dx, y + dy) === WATER);
    }

    /**
     * 水が一段広がる。泉と水のマスから、下と左右の空いたマスへ。上へは行かない。
     * 地図の文字を書き換えるだけで、画面は次の draw で丸ごと作り直される。
     */
    function flow(): void {
        const next: [number, number][] = [];
        for (let y = 0; y < FIELD_ROWS; ++y) {
            for (let x = 0; x < COLUMNS; ++x) {
                const code = world.get(x, y);
                if (code !== WATER && code !== SPRING) continue;
                for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0]]) {
                    if (inside(x + dx, y + dy) && y + dy > SURFACE && world.get(x + dx, y + dy) === EMPTY) next.push([x + dx, y + dy]);
                }
            }
        }
        for (const [x, y] of next) world.put(x, y, WATER);
    }

    /**
     * 機械の手。一番近い宝石への道を幅優先で探し、その一歩目を返す。水の隣は
     * 通らないが、泉の隣は平気で掘る（そこから水が出てきて、逃げることになる）。
     * 道が無ければ、行ける方へ掘る。
     */
    function autopilot(): [number, number] {
        const from = new Int16Array(COLUMNS * FIELD_ROWS).fill(-1);
        const start = digger.cy * COLUMNS + digger.cx;
        from[start] = start;
        const queue = [start];
        const dirs: [number, number][] = [[0, 1], [1, 0], [-1, 0], [0, -1]];
        while (queue.length) {
            const at = queue.shift()!;
            const x = at % COLUMNS, y = Math.floor(at / COLUMNS);
            if (world.get(x, y) === GEM) {
                let step = at;
                while (from[step] !== start) step = from[step];
                return [step % COLUMNS - digger.cx, Math.floor(step / COLUMNS) - digger.cy];
            }
            for (const [dx, dy] of dirs) {
                const nx = x + dx, ny = y + dy, n = ny * COLUMNS + nx;
                if (!inside(nx, ny) || from[n] >= 0 || !passable(world.get(nx, ny)) || nearWater(nx, ny)) continue;
                from[n] = at;
                queue.push(n);
            }
        }
        const open = dirs.filter(([dx, dy]) => inside(digger.cx + dx, digger.cy + dy) && passable(world.get(digger.cx + dx, digger.cy + dy)));
        return open[Math.floor(env.random() * open.length)] ?? [0, 0];
    }

    function lose({ bgm }: Context): void {
        lives--;
        bgm.effect(psgVoice(2), "t120 v14 q8 l16 o5 c<bagfedc");
        if (lives <= 0) over = 240;
        else {
            pause = 90;
            newMap();
        }
    }

    /** 掘る人を進める。マスに着いたら、そこで次の一歩を選ぶ。 */
    function walk(ctx: Context, choose: () => [number, number]): void {
        const { bgm } = ctx;
        if (digger.cx !== digger.tx || digger.cy !== digger.ty) {
            if (++digger.t < digger.span) return;
            digger.cx = digger.tx;
            digger.cy = digger.ty;
            if (world.get(digger.cx, digger.cy) === GEM) {
                score += 50 * level;
                left--;
                bgm.effect(psgVoice(2), "t150 v13 l32 o6 ceg>c");
            }
            world.put(digger.cx, digger.cy, EMPTY);
        }
        const [dx, dy] = choose();
        if (dx === 0 && dy === 0) return;
        const nx = digger.cx + dx, ny = digger.cy + dy;
        if (!inside(nx, ny) || !passable(world.get(nx, ny))) return;
        const code = world.get(nx, ny);
        const digging = code === SOIL || code === TOPSOIL;
        digger = { ...digger, tx: nx, ty: ny, t: 0, span: digging ? DIG : STEP };
        if (digging) bgm.effect(psgVoice(2), "t150 v9 w8 l32 o3 c");
    }

    // --- キャラクタ -----------------------------------------------------------

    function defineCharacters({ tiles }: Context): void {
        tiles.loadFont({ foreground: 15, background: 0 });
        // 一行に二色まで。"." は色 0（透明で、背景色が見える）。
        tiles.defineMulticolor(TOPSOIL, [
            "4.4..4.4",
            "44444444",
            "33233323",
            "32333333",
            "33333233",
            "23333332",
            "33323333",
            "33333323"
        ]);
        tiles.defineMulticolor(SOIL, [
            "33233323",
            "32333333",
            "33333233",
            "23333332",
            "33323333",
            "33333323",
            "32333333",
            "33332333"
        ]);
        tiles.defineMulticolor(ROCK, [
            "55666655",
            "56666665",
            "66655666",
            "66555566",
            "65555556",
            "65555556",
            "56555565",
            "55655655"
        ]);
        tiles.define(GEM, [
            "........",
            "...##...",
            "..####..",
            ".##.###.",
            ".######.",
            "..####..",
            "...##...",
            "........"
        ], 9, 2);
        tiles.defineMulticolor(SPRING, [
            "77777777",
            "7b7777b7",
            "77bb7b77",
            "b77bb77b",
            "7bb77bb7",
            "77777777",
            "7b7777b7",
            "77777777"
        ], { palette: { b: 11 } });
    }

    /**
     * 書き換えて動かす文字。画面の名前表には触れない。水は波の形を、宝石は
     * 行ごとの色だけを回す。
     */
    function animate({ tiles }: Context): void {
        if (frame % 4 !== 0) return;
        const phase = frame >> 2;
        const wave: number[] = [];
        for (let y = 0; y < 8; ++y) {
            let bits = 0;
            for (let x = 0; x < 8; ++x) {
                const crest = y === Math.round(1 + Math.sin((x + phase) * 0.8)) || ((x * 3 + y * 5 + phase) & 15) === 0;
                if (crest) bits |= 0x80 >> x;
            }
            wave.push(bits);
        }
        tiles.setPattern(WATER, wave);
        tiles.setColor(WATER, 8, 7);

        const glint = [9, 10, 11, 10];
        tiles.setRowColors(GEM, Array.from({ length: 8 }, (_, y) => (glint[(phase + y) & 3] << 4) | 2));
    }

    /** 画面を一から作る。地図を写し、点数と案内を重ねる。 */
    function compose(): void {
        screenBuffer.clear(EMPTY);
        screenBuffer.transfer(world, 0, FIELD_TOP);
        screenBuffer.print(1, 0, `SCORE ${String(score).padStart(6, "0")}  GEM ${left}  LV ${level}  ${"*".repeat(Math.max(0, lives))}`);
        const status = over > 0 ? "GAME OVER"
            : pause > 0 ? (left === 0 ? "CLEAR!" : "READY")
            : demo ? "DEMO - ARROWS TO DIG" : "DIG DOWN, MIND THE WATER";
        screenBuffer.print(1, 23, status);
    }

    const app: App = {
        init(ctx) {
            const { screen, sprites, bgm, tiles } = ctx;
            screen.setMode("G3");                  // SCREEN 4。キャラクタと MSX2 のスプライト
            screen.setPalette(PALETTE);
            screen.setBackdrop(1);
            defineCharacters(ctx);

            sprites.setSize(8);
            // 一行に三色なら、そのうち一色は残り二色の OR（12|3 = 15）。
            // 8x8 の多色は2枠を使う（0 と 1、2 と 3）。
            const body = [
                "..cccc..",
                ".cc3fcc.",
                ".b1bb1b.",
                "..bbbb..",
                ".dddddd.",
                "d.dddd.d"
            ];
            standing = sprites.setMulticolorPattern(0, [...body, "..d..d..", ".33..33."]);
            stepping = sprites.setMulticolorPattern(2, [...body, ".d....d.", "33....33"]);
            sprites.setActiveCount(2);

            reset();
            compose();
            tiles.transfer(screenBuffer);
            bgm.play(theme, { loop: true });
        },

        update(ctx) {
            const { input } = ctx;
            frame++;

            const axis = input.axis();
            const touched = axis.x !== 0 || axis.y !== 0 || input.btn(BUTTON.A);
            if (touched) {
                demo = false;
                idle = 0;
            } else if (!demo && ++idle > 600) {
                demo = true;
            }

            if (over > 0) {
                if (--over === 0) reset();
                return;
            }
            if (pause > 0) {
                pause--;
                return;
            }

            walk(ctx, () => demo ? autopilot() : axis.x !== 0 ? [axis.x, 0] : [0, axis.y]);
            if (frame % Math.max(8, 30 - level * 4) === 0) flow();

            const here = world.get(digger.cx, digger.cy);
            const ahead = world.get(digger.tx, digger.ty);
            if (here === WATER || ahead === WATER) lose(ctx);
            else if (left === 0) {
                level++;
                score += 200;
                pause = 90;
                newMap();
            }
        },

        draw(ctx) {
            const { tiles, sprites } = ctx;
            animate(ctx);
            compose();
            tiles.transfer(screenBuffer);          // 768バイト、毎フレーム丸ごと

            if (over > 0) {
                sprites.hide(SPRITE_DIGGER);
                return;
            }
            const k = digger.t / digger.span;
            const x = Math.round((digger.cx + (digger.tx - digger.cx) * k) * 8);
            const y = Math.round((FIELD_TOP + digger.cy + (digger.ty - digger.cy) * k) * 8);
            const moving = digger.cx !== digger.tx || digger.cy !== digger.ty;
            sprites.setMulticolor(SPRITE_DIGGER, { x, y, pattern: moving && (frame >> 3) % 2 ? stepping : standing });
        }
    };
    return app;
};

export default create;
