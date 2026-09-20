// ロールプレイングゲームの実例。地図を歩き、敵に会い、枠の中のコマンドを選ぶ。
//
// 地図は 16x16 の区画を並べたもので、**部屋が変わるときにだけ**描く。歩くたびに
// 描き直すと、それだけで検査の時間切れになる。主人公はスプライトなので、
// 動かすのに描画は要らない。
//
// 戦いは別の画面。上に敵、下に枠とコマンド。文章と数値は、変わったところだけを
// 描きかえる。日本語は @fanm/work の DOT_STYLE を ctx.text に渡して組む。
//
// 無操作でも、歩き、出会い、戦い、また歩く。操作が来たらその指示で歩く。

import { BUTTON, compile, opllVoice, psgVoice, type App, type Context } from "fantasy-msx";
import { DOT_STYLE, type WorkFactory } from "@fanm/work";

const TILE = 16;
const COLS = 16;
const ROWS = 12;                       // 16x12 区画 = 256x192。下の 20 画素は表示欄
const STATUS_Y = ROWS * TILE;       // 表示欄の上端。戦いの枠もここより上に収める

/** 地図。# 岩 / . 草 / T 木 / ~ 水 / = 道 / D 出口 */
const MAPS: readonly (readonly string[])[] = [
    [
        "################",
        "#....TT...~~~~~#",
        "#.TT.......~~~~#",
        "#..........~~~~#",
        "#==============D",
        "#....T.....~~~~#",
        "#.TTT......~~~~#",
        "#..........~~~~#",
        "#....TT.....~~~#",
        "#..........~~~~#",
        "#.TT...........#",
        "################"
    ],
    [
        "################",
        "#..............#",
        "#.####....####.#",
        "#.#..#....#..#.#",
        "D.#..######..#.#",
        "#.#.........##.#",
        "#.####.####....#",
        "#....#.#..#.##.#",
        "#.##.#.#..#..#.#",
        "#..#...#######.#",
        "#..............#",
        "################"
    ]
];

/** 通れない区画。 */
const SOLID = "#T~";

interface Enemy {
    readonly name: string;
    readonly hp: number;
    readonly attack: number;
    readonly color: number;
}

const ENEMIES: readonly Enemy[] = [
    { name: "どうくつネズミ", hp: 6, attack: 2, color: 9 },
    { name: "はいいろのカビ", hp: 9, attack: 3, color: 10 },
    { name: "みずのぬし", hp: 12, attack: 4, color: 7 }
];

const create: WorkFactory = env => {
    let frame = 0;
    let mode: "field" | "battle" = "field";

    // 地図の上の自分。tx/ty は区画、offset は区画の中でどこまで進んだか。
    let map = 0;
    let tx = 2;
    let ty = 2;
    let offset = 0;
    let dir = { x: 0, y: 1 };
    let steps = 0;
    let until = 8 + Math.floor(env.random() * 8);     // 次に敵が出るまでの歩数

    let hp = 20;
    const maxHp = 20;
    let level = 1;
    let exp = 0;
    let shownStatus = "";

    // 戦いの状態。
    let enemy = ENEMIES[0];
    let enemyHp = 0;
    let phase: "command" | "message" = "command";
    let cursor = 0;
    let wait = 0;
    let message = "";
    let messageChars = 0;
    let messagePen = 0;

    let idle = 0;
    let demo = true;

    const field = compile([
        { voice: psgVoice(0), mml: "t128 v9 q6 l8 o5 [c e g e  f a g e]2" },
        { voice: psgVoice(1), mml: "t128 v7 q7 l4 o3 [c c f f]2" },
        { voice: opllVoice(0), mml: "t128 @9 v9 l2 o3 [c f]2" }
    ]);
    const fight = compile([
        { voice: psgVoice(0), mml: "t168 v11 q5 l16 o5 [ccgg>c<bag]2" },
        { voice: psgVoice(1), mml: "t168 v9 q6 l8 o3 [c c g g]4" },
        { voice: opllVoice(0), mml: "t168 @14 v10 l4 o3 [c c a+ a+]2" }
    ]);

    function tile(x: number, y: number): string {
        return MAPS[map][y]?.[x] ?? "#";
    }

    function blocked(x: number, y: number): boolean {
        return SOLID.includes(tile(x, y));
    }

    /** 区画を一つ描く。地図を描くときと、部屋が変わったときだけ通る。 */
    function paintTile({ gfx }: Context, x: number, y: number): void {
        const kind = tile(x, y);
        const px = x * TILE;
        const py = y * TILE;
        if (kind === "#") {
            gfx.now.fillRect(px, py, TILE, TILE, 4);
            gfx.now.hline(px, py, TILE, 5);
            gfx.now.hline(px, py + 8, TILE, 5);
            gfx.now.vline(px + 4, py, 8, 5);
            gfx.now.vline(px + 11, py + 8, 8, 5);
            return;
        }
        gfx.now.fillRect(px, py, TILE, TILE, kind === "=" ? 6 : 2);
        if (kind === "T") {
            gfx.now.fillRect(px + 6, py + 9, 4, 7, 4);
            gfx.now.fillCircle(px + 8, py + 6, 6, 3);
        } else if (kind === "~") {
            gfx.now.fillRect(px, py, TILE, TILE, 12);
            gfx.now.hline(px + 2, py + 5, 6, 13);
            gfx.now.hline(px + 8, py + 11, 6, 13);
        } else if (kind === "D") {
            gfx.now.fillRect(px + 2, py + 2, 12, 14, 8);
            gfx.now.rect(px + 2, py + 2, 12, 14, 15);
        } else if ((x * 7 + y * 13) % 5 === 0) {
            gfx.now.pixel(px + 5, py + 6, 3);                // 草の点。平らに見せない
            gfx.now.pixel(px + 10, py + 11, 3);
        }
    }

    function paintMap(ctx: Context): void {
        for (let y = 0; y < ROWS; ++y) for (let x = 0; x < COLS; ++x) paintTile(ctx, x, y);
    }

    /** 下の表示欄。値が変わったときだけ描きかえる。 */
    function status(ctx: Context): void {
        const text = `LV ${level}  HP ${hp}/${maxHp}  EXP ${exp}`;
        if (text === shownStatus) return;
        ctx.gfx.now.fillRect(0, STATUS_Y, 256, 212 - STATUS_Y, 0);
        ctx.gfx.now.text(6, STATUS_Y + 6, text, 15);
        shownStatus = text;
    }

    /** 戦いの画面。枠と敵を置く。 */
    function paintBattle(ctx: Context): void {
        const { gfx } = ctx;
        gfx.now.clear(0);
        gfx.now.fillRect(0, 0, 256, 96, 1);
        gfx.now.hline(0, 96, 256, 5);

        // 敵。丸と四角の組み合わせで足りる。
        gfx.now.fillCircle(128, 56, 26, enemy.color);
        gfx.now.fillCircle(128, 46, 20, enemy.color + 1);
        gfx.now.fillCircle(118, 44, 4, 0);
        gfx.now.fillCircle(138, 44, 4, 0);
        gfx.now.fillRect(112, 62, 32, 4, 0);

        gfx.now.rect(4, 104, 248, 84, 15);
        gfx.now.rect(6, 106, 244, 80, 14);
        ctx.text.drawNow(16, 116, `${enemy.name} が あらわれた`, { color: 15 });
        shownStatus = "";
        status(ctx);
    }

    /** 戦いの文章。一行だけを出しなおす。 */
    function say(ctx: Context, text: string): void {
        ctx.gfx.now.fillRect(12, 140, 232, 16, 0);
        message = text;
        messageChars = 0;
        messagePen = 0;
        phase = "message";
        wait = 0;
    }

    function drawCommands(ctx: Context): void {
        const labels = ["たたかう", "にげる"];
        labels.forEach((label, n) => {
            const y = 156 + n * 16;
            ctx.gfx.now.fillRect(16, y, 12, 14, 0);
            ctx.gfx.now.text(18, y + 3, n === cursor ? ">" : " ", 14);
            ctx.text.drawNow(34, y, label, { color: 15 });
        });
    }

    function startBattle(ctx: Context): void {
        mode = "battle";
        enemy = ENEMIES[Math.floor(env.random() * ENEMIES.length)];
        enemyHp = enemy.hp;
        phase = "command";
        cursor = 0;
        wait = 90;
        ctx.sprites.setActiveCount(0);
        paintBattle(ctx);
        drawCommands(ctx);
        ctx.bgm.play(fight, { loop: true });
    }

    function backToField(ctx: Context): void {
        mode = "field";
        steps = 0;
        until = 8 + Math.floor(env.random() * 10);
        ctx.gfx.now.clear(0);
        paintMap(ctx);
        shownStatus = "";
        status(ctx);
        ctx.sprites.setActiveCount(1);
        ctx.bgm.play(field, { loop: true });
    }

    /** 歩く向きを決める。人が触っていなければ、自分で決める。 */
    function steer(ctx: Context): { x: number; y: number } {
        const axis = ctx.input.axis();
        if (axis.x || axis.y) {
            demo = false;
            idle = 0;
            return { x: axis.x, y: axis.y ? (axis.x ? 0 : axis.y) : 0 };
        }
        if (!demo && ++idle > 600) demo = true;
        if (!demo) return { x: 0, y: 0 };

        // まっすぐ進めるなら進む。だめなら曲がる。
        if (!blocked(tx + dir.x, ty + dir.y) && env.random() > 0.15) return dir;
        const ways = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]
            .filter(way => !blocked(tx + way.x, ty + way.y));
        return ways[Math.floor(env.random() * ways.length)] ?? { x: 0, y: 0 };
    }

    const app: App = {
        init(ctx) {
            const { screen, sprites, text, bgm } = ctx;
            screen.setMode("G4");
            screen.setColor(1, 0, 0, 2);
            screen.setColor(2, 1, 3, 1);       // 草
            screen.setColor(3, 0, 5, 2);       // 葉
            screen.setColor(4, 3, 2, 1);       // 岩・幹
            screen.setColor(5, 5, 4, 3);
            screen.setColor(6, 5, 4, 2);       // 道
            screen.setColor(12, 1, 2, 6);      // 水
            screen.setColor(13, 4, 5, 7);
            text.style = DOT_STYLE;

            sprites.setSize(16);
            sprites.setPatternFromBitmap(0, [                  // 歩く人（足をそろえた形）
                "................", ".....######.....",
                "....########....", "....##.##.##....",
                "....########....", ".....######.....",
                "......####......", "....########....",
                "...####..####...", "...###....###...",
                "...##########...", "....########....",
                "....##....##....", "....##....##....",
                "....##....##....", "...###....###..."
            ]);
            sprites.setPatternFromBitmap(4, [                  // もう一枚。足を開いた形
                "................", ".....######.....",
                "....########....", "....##.##.##....",
                "....########....", ".....######.....",
                "......####......", "....########....",
                "...####..####...", "...###....###...",
                "...##########...", "....########....",
                "...###....###...", "..###......###..",
                "..##........##..", ".###........###."
            ]);
            sprites.set(0, { x: tx * TILE, y: ty * TILE, pattern: 0, color: 15 });
            sprites.setActiveCount(1);

            paintMap(ctx);
            status(ctx);
            bgm.play(field, { loop: true });
        },

        update(ctx) {
            const { input, sprites } = ctx;
            frame++;

            if (mode === "battle") {
                const decide = input.btnp(BUTTON.A) || input.btnp(BUTTON.B);
                if (input.btnp(BUTTON.UP) || input.btnp(BUTTON.DOWN)) {
                    cursor = 1 - cursor;
                    drawCommands(ctx);
                    demo = false;
                    idle = 0;
                }

                if (phase === "message") {
                    // 文章を一字ずつ。出し終えたら少し置いて、次へ。
                    const source = [...message];
                    if (messageChars < source.length) {
                        const glyph = source[messageChars];
                        ctx.text.drawNow(16 + messagePen, 142, glyph, { color: 15 });
                        messagePen += ctx.text.measure(glyph).width;
                        messageChars++;
                        return;
                    }
                    if (--wait > 0 && !decide) return;

                    if (hp <= 0) {                                  // 負けた。少し休んで戻る
                        hp = maxHp;
                        level = Math.max(1, level - 1);
                        backToField(ctx);
                        return;
                    }
                    if (enemyHp <= 0) {                             // 勝った
                        exp += enemy.hp;
                        if (exp >= level * 12) {
                            level++;
                            exp = 0;
                            hp = maxHp;
                        }
                        backToField(ctx);
                        return;
                    }
                    phase = "command";
                    wait = 90;
                    drawCommands(ctx);
                    return;
                }

                // コマンド待ち。放っておけば自分で決める。
                if (--wait > 0 && !decide) return;
                if (cursor === 1 && env.random() < 0.5) {
                    say(ctx, "うまく にげられた");
                    enemyHp = 0;
                    exp += 1;
                    wait = 60;
                    return;
                }
                const damage = 2 + Math.floor(env.random() * (2 + level));
                enemyHp -= damage;
                if (enemyHp <= 0) {
                    say(ctx, `${enemy.name} を たおした`);
                    wait = 90;
                    return;
                }
                hp -= Math.max(1, enemy.attack - Math.floor(level / 2));
                status(ctx);
                say(ctx, hp > 0 ? `${damage} の ダメージ / はんげき ${enemy.attack}` : "めのまえが まっくらに なった");
                wait = 70;
                return;
            }

            // --- 地図を歩く ---
            if (offset === 0) {
                const way = steer(ctx);
                if (way.x || way.y) {
                    dir = way;
                    if (!blocked(tx + dir.x, ty + dir.y)) offset = 1;
                }
            }
            if (offset > 0) {
                offset += 2;
                if (offset >= TILE) {
                    offset = 0;
                    tx += dir.x;
                    ty += dir.y;
                    steps++;

                    if (tile(tx, ty) === "D") {                     // 出口。部屋を変える
                        map = (map + 1) % MAPS.length;
                        tx = dir.x > 0 ? 1 : COLS - 2;
                        paintMap(ctx);
                        shownStatus = "";
                        status(ctx);
                    } else if (steps >= until) {
                        startBattle(ctx);
                        return;
                    }
                }
            }

            // 歩く絵は2枚を交互に。動くものはスプライトなので、描画は要らない。
            const walking = offset > 0;
            sprites.set(0, {
                x: tx * TILE + dir.x * offset,
                y: ty * TILE + dir.y * offset,
                pattern: walking && (frame >> 3) % 2 === 1 ? 4 : 0,
                color: 15
            });
        }
    };
    return app;
};

export default create;
