// 横スクロールアクションの実例。右へ走り、穴を跳び越え、敵を踏む。
//
// この型の勘どころは、画面を描き直さずに流すこと。
//
//   1. 地面は描いたまま動かさない。ctx.scroll で「どこから見るか」を動かす。
//      scroll.wide でページ2と3を横に並べ、幅512の平面にする。平面は輪なので、
//      右から入ってくる列を、左へ出ていった列の場所へ一本ずつ描き足す。
//      描くのは画面の外（平面の見えていない側）なので、描いている途中は見えない。
//   2. 画面を横の帯に分け（scroll.split）、帯ごとに違う速さで流す。遠くの丘は
//      ゆっくり、足元の地面はカメラと同じ速さ。これが視差のすべて。
//      点数の帯はページ0に置き、動かさない。
//   3. 動くもの（主人公、敵、コイン）はすべてスプライト。座標は画面の座標で渡す。
//      横のスクロールはスプライトを動かさないので、世界の座標からカメラを引いて置く。
//      主人公は多色スプライト（二枚重ねで一行に三色まで）。
//
// 誰も触らなくても遊びが進むこと。最初は機械が自分で走り、跳ぶ。

import { BUTTON, compile, opllVoice, psgVoice, type App, type Context, type MulticolorPattern, type ScrollBand } from "fantasy-msx";
import type { WorkFactory } from "@fanm/work";

// 画面の帯。上から、点数（ページ0）、雲、丘、地面（ここから下がカメラと同じ速さ）。
const HUD_HEIGHT = 16;
const CLOUDS_TOP = 16;
const HILLS_TOP = 56;
const FIELD_TOP = 112;
const SCREEN_BOTTOM = 212;

const TILE = 8;
/** 平面の幅。ページ2と3を並べた512画素で一周する。 */
const PLANE_WIDTH = 512;
/** 平面の左半分のページ。右半分はその次（3）。 */
const PLANE_PAGE = 2;

const RUN = 2;               // 走る速さ（画素／フレーム）
const GRAVITY = 0.35;
const JUMP = 6.2;
const CAMERA_LEAD = 96;      // 主人公を画面の左からこれだけの所に置く

// スプライトの割り当て。0番と1番は主人公（多色なので二枚）、2〜7番は敵、8〜15番はコイン。
const SPRITE_PLAYER = 0;
const SPRITE_ENEMIES = 2;
const ENEMY_SLOTS = 6;
const SPRITE_COINS = SPRITE_ENEMIES + ENEMY_SLOTS;
const COIN_SLOTS = 8;

/** 16色。各 0〜7。 */
const PALETTE: [number, number, number][] = [
    [0, 0, 0], [1, 1, 3], [3, 5, 7], [7, 7, 7],
    [4, 6, 7], [3, 4, 6], [5, 6, 7], [2, 6, 1],
    [5, 3, 1], [3, 2, 1], [7, 6, 1], [7, 2, 1],
    [7, 5, 4], [2, 3, 5], [1, 4, 1], [7, 7, 7]
];

interface Enemy {
    x: number;              // 世界の座標（左端）
    y: number;              // 画面の行（上端）
    vx: number;
    squashed: number;       // 踏まれてから消えるまでの残りフレーム。0 なら歩いている
}

interface Coin {
    x: number;
    y: number;
}

const create: WorkFactory = env => {
    let frame = 0;
    let score = 0;
    let coins = 0;
    let lives = 3;
    let shown = "";                     // 最後に描いた点数の行。変わったときだけ描き直す
    let over = 0;                       // 0 より大きいと、やり直しまでの残りフレーム
    let demo = true;                    // 機械が遊んでいるか
    let idle = 0;                       // 最後に人が触ってからのフレーム数

    let player = { x: 64, y: 100, vy: 0, onGround: false, blink: 0 };
    let standing: MulticolorPattern;
    let running: MulticolorPattern;
    let cameraX = 0;

    // 地面の高さ（区画の段数）。0 は穴。列は右へ進むたびに作り足す。
    let heights: number[] = [];
    let enemies: Enemy[] = [];
    let items: Coin[] = [];
    let drawn = -1;                     // 平面に描いた一番右の列
    let run = 0;                        // 同じ高さが続いている列の数
    let pit = 0;                        // 掘っている穴の、残りの列数

    // 帯。init で作り、update では x を動かすだけ。
    let clouds: ScrollBand;
    let hills: ScrollBand;
    let field: ScrollBand;

    const theme = compile([
        { voice: psgVoice(0), mml: "t150 v10 q5 l8 o5 [c c g e f d g4]2 [a a f d e c d4]" },
        { voice: psgVoice(1), mml: "t150 v8 q6 l8 o3 [c g c g f a g b]2 [f a f a c g g b]" },
        { voice: opllVoice(0), mml: "t150 @13 v9 l2 o3 [c f c g]2 [f c f g]" }
    ]);

    // --- 地面 --------------------------------------------------------------

    /** 列 column の地面を決める。左から順に一度ずつ呼ぶ。 */
    function generate(column: number): void {
        const last = heights[column - 1] ?? 4;
        let height = last;
        if (column < 24) {
            height = 4;                                     // 出だしは平らにして走り出しを見せる
        } else if (pit > 0) {
            height = --pit > 0 ? 0 : 3 + Math.floor(env.random() * 3);        // 穴の向こう岸
        } else if (run > 5) {
            const roll = env.random();
            if (roll < 0.25) {
                pit = 2 + Math.floor(env.random() * 3);                         // 穴。2〜4列
                height = 0;
            } else if (roll < 0.55) {
                height = Math.max(2, Math.min(6, last + (env.random() < 0.5 ? -1 : 1)));
            }
        }
        run = height === last ? run + 1 : 0;
        heights[column] = height;

        if (height > 0 && column > 30) {
            const top = groundTopOf(column);
            if (run > 2 && env.random() < 0.12) {
                enemies.push({ x: column * TILE, y: top - 16, vx: -0.5, squashed: 0 });
            } else if (env.random() < 0.15) {
                items.push({ x: column * TILE, y: top - 40 });
            }
        }
    }

    /** 列の地面の上端の行。穴なら画面の外。 */
    function groundTopOf(column: number): number {
        const height = heights[column] ?? 0;
        return height > 0 ? SCREEN_BOTTOM - height * TILE : SCREEN_BOTTOM + 64;
    }

    /** 世界の x の真下の地面。 */
    function groundAt(x: number): number {
        return groundTopOf(Math.floor(x / TILE));
    }

    /**
     * 列を一本、平面に描く。平面の x は世界の x を512で折り返したもの。
     * 左半分はページ2、右半分はページ3に入る。
     */
    function drawColumn({ screen, gfx }: Context, column: number): void {
        while (heights.length <= column) generate(heights.length);
        const planeX = (column * TILE) % PLANE_WIDTH;
        screen.setDrawPage(PLANE_PAGE + (planeX >> 8));
        const x = planeX & 255;
        const top = groundTopOf(column);
        gfx.now.fillRect(x, FIELD_TOP, TILE, SCREEN_BOTTOM - FIELD_TOP, 6);
        if (top >= SCREEN_BOTTOM) return;
        gfx.now.fillRect(x, top, TILE, SCREEN_BOTTOM - top, 8);
        gfx.now.fillRect(x, top, TILE, 3, 7);
        for (let y = top + 6; y < SCREEN_BOTTOM; y += 6) {
            gfx.now.pixel(x + ((column * 5 + y) % TILE), y, 9);                // 土の粒
        }
    }

    /** カメラが見る列が平面に描いてあるようにする。all なら見える分を全部描き直す。 */
    function stream(ctx: Context, all = false): void {
        const right = Math.floor((cameraX + 256) / TILE) + 1;
        if (all) drawn = Math.floor(cameraX / TILE) - 1;
        while (drawn < right) drawColumn(ctx, ++drawn);
    }

    /**
     * 遠景。平面の上のほう（雲と丘の帯）に一度だけ描く。輪なので、512 の端を
     * またぐ絵は両方のページに描く。描き終えたら二度と触らない。
     */
    function scenery({ screen, gfx }: Context): void {
        for (let page = PLANE_PAGE; page <= PLANE_PAGE + 1; ++page) {
            screen.setDrawPage(page);
            gfx.now.fillRect(0, CLOUDS_TOP, 256, HILLS_TOP - CLOUDS_TOP, 2);
            gfx.now.fillRect(0, HILLS_TOP, 256, FIELD_TOP - HILLS_TOP, 4);
        }
        const puffs = Array.from({ length: 7 }, () => ({
            x: Math.floor(env.random() * PLANE_WIDTH),
            y: CLOUDS_TOP + 10 + Math.floor(env.random() * 20),
            r: 5 + Math.floor(env.random() * 5)
        }));
        for (let page = PLANE_PAGE; page <= PLANE_PAGE + 1; ++page) {
            screen.setDrawPage(page);
            for (const wrap of [-1, 0, 1]) {
                const dx = wrap * PLANE_WIDTH - (page - PLANE_PAGE) * 256;
                for (const p of puffs) {
                    gfx.now.fillCircle(p.x + dx, p.y, p.r, 3);
                    gfx.now.fillCircle(p.x + dx + p.r, p.y + 2, p.r - 1, 3);
                }
            }
        }
        // 丘の稜線。512 で一周する波なので、端がつながる。
        for (let x = 0; x < PLANE_WIDTH; ++x) {
            const t = (x / PLANE_WIDTH) * Math.PI * 2;
            const height = Math.round(22 + 9 * Math.sin(t * 3) + 5 * Math.sin(t * 7 + 1));
            screen.setDrawPage(PLANE_PAGE + (x >> 8));
            gfx.now.vline(x & 255, FIELD_TOP - height, height, 5);
        }
    }

    /** 点数の帯。ページ0にあり、帯ごと止まっている。変わったときだけ描く。 */
    function hud({ screen, gfx }: Context): void {
        const text = `SCORE ${String(score).padStart(6, "0")}  COIN ${String(coins).padStart(2, "0")}  ${"*".repeat(Math.max(0, lives))}`;
        if (text === shown) return;
        shown = text;
        screen.setDrawPage(0);
        gfx.now.fillRect(0, 0, 256, HUD_HEIGHT, 1);
        gfx.now.text(8, 4, text, 15);
    }

    // --- 遊び --------------------------------------------------------------

    function restart(ctx: Context): void {
        heights = [];
        enemies = [];
        items = [];
        run = 0;
        pit = 0;
        score = 0;
        coins = 0;
        lives = 3;
        over = 0;
        cameraX = 0;
        player = { x: 64, y: groundTopOf(8) - 16, vy: 0, onGround: true, blink: 0 };
        stream(ctx, true);
        player.y = groundAt(player.x + 8) - 16;
    }

    /** 落ちるか当たるかしたら、少し先の地面の上から出直す。 */
    function miss(): void {
        lives--;
        if (lives <= 0) {
            over = 180;
            return;
        }
        let column = Math.floor((cameraX + 48) / TILE);
        while (heights[column] === 0 || heights[column + 1] === 0) column++;
        player = { x: column * TILE, y: groundTopOf(column) - 40, vy: 0, onGround: false, blink: 90 };
        enemies = enemies.filter(e => Math.abs(e.x - player.x) > 64);
    }

    /**
     * 機械の手。いつも右へ走り、前に穴、段、敵があれば跳ぶ。
     * 落ちている途中で前が穴なら、足元に地面があるうちは進むのをやめて手前に降りる
     * （降りてから跳び直す）。人が遊んでいるように見えればよく、うまい必要はない。
     */
    function autopilot(): { move: number; jump: boolean } {
        const front = player.x + 16;
        const pit = [0, 6, 12].some(d => groundAt(front + d) > SCREEN_BOTTOM);
        if (!player.onGround) {
            const footing = groundAt(player.x + 3) < SCREEN_BOTTOM && groundAt(player.x + 12) < SCREEN_BOTTOM;
            const wait = player.vy > 0 && footing && groundAt(front + 2) > SCREEN_BOTTOM;
            return { move: wait ? 0 : 1, jump: false };
        }
        const step = groundAt(front + 4) < player.y + 16;
        const foe = enemies.some(e => !e.squashed && e.x - front > 0 && e.x - front < 30 && Math.abs(e.y - player.y) < 16);
        return { move: 1, jump: pit || step || foe };
    }

    function movePlayer(ctx: Context, move: number, jump: boolean): void {
        const { bgm } = ctx;
        // 横。前の足元の地面が腰より高ければ壁なので進まない。
        const nx = Math.max(cameraX + 8, player.x + move * RUN);
        const foot = move >= 0 ? nx + 13 : nx + 2;
        if (groundAt(foot) >= player.y + 15) player.x = nx;

        if (jump && player.onGround) {
            player.vy = -JUMP;
            player.onGround = false;
            bgm.effect(psgVoice(2), "t150 v12 l32 o5 c e g");
        }

        // 縦。落ちているときだけ、足元の地面に乗る。
        player.vy = Math.min(6, player.vy + GRAVITY);
        const before = player.y + 16;
        player.y += player.vy;
        const ground = Math.min(groundAt(player.x + 3), groundAt(player.x + 12));
        player.onGround = false;
        if (player.vy >= 0 && player.y + 16 >= ground && before <= ground + 1) {
            player.y = ground - 16;
            player.vy = 0;
            player.onGround = true;
        }
        if (player.y > SCREEN_BOTTOM) {
            bgm.effect(psgVoice(2), "t150 v13 l16 o4 g e c <g");
            miss();
        }
    }

    function moveEnemies(ctx: Context): void {
        for (const enemy of enemies) {
            if (enemy.squashed) {
                enemy.squashed--;
                continue;
            }
            // 穴や段の手前で向きを変える。
            const ahead = enemy.vx < 0 ? enemy.x - 1 : enemy.x + 16;
            if (groundAt(ahead) !== enemy.y + 16) enemy.vx = -enemy.vx;
            else enemy.x += enemy.vx;

            const overlap = Math.abs(enemy.x - player.x) < 12 && Math.abs(enemy.y - player.y) < 14;
            if (!overlap || player.blink > 0) continue;
            if (player.vy > 0 && player.y + 16 < enemy.y + 10) {
                enemy.squashed = 20;                        // 踏んだ
                player.vy = -4;
                score += 100;
                ctx.bgm.effect(psgVoice(2), "t150 v13 l32 o6 c <g >c");
            } else {
                ctx.bgm.effect(psgVoice(2), "t150 v14 w12 l16 o3 c");
                miss();
                return;
            }
        }
        enemies = enemies.filter(e => e.x > cameraX - 32 && (e.squashed !== 1));
    }

    function collect(ctx: Context): void {
        items = items.filter(coin => {
            if (coin.x < cameraX - 16) return false;
            if (Math.abs(coin.x - player.x) < 12 && Math.abs(coin.y - player.y) < 14) {
                coins++;
                score += 10;
                ctx.bgm.effect(psgVoice(2), "t150 v12 l32 o6 e b");
                return false;
            }
            return true;
        });
    }

    /**
     * スプライトを置き直す。世界の座標からカメラを引いた画面の座標で渡す。
     * 画面の外に出たものは hide。x が負のまま渡すと反対の端に出る。
     */
    function place({ sprites }: Context): void {
        const sx = Math.round(player.x - cameraX);
        const stride = player.onGround && (frame >> 3) % 2 === 1;
        // 多色の組は hide で二枚とも隠れる。絵を替えるので毎回 setMulticolor で置き直す。
        if (player.blink > 0 && (frame >> 2) % 2 === 0) sprites.hide(SPRITE_PLAYER);
        else sprites.setMulticolor(SPRITE_PLAYER, { x: sx, y: Math.round(player.y), pattern: stride ? running : standing });

        const visible = (x: number) => x >= 0 && x <= 255;
        let slot = 0;
        for (const enemy of enemies) {
            const x = Math.round(enemy.x - cameraX);
            if (!visible(x) || slot >= ENEMY_SLOTS) continue;
            const pattern = enemy.squashed ? 20 : (frame >> 4) % 2 ? 16 : 24;
            sprites.set(SPRITE_ENEMIES + slot++, { x, y: Math.round(enemy.y), pattern, color: 11 });
        }
        while (slot < ENEMY_SLOTS) sprites.hide(SPRITE_ENEMIES + slot++);

        slot = 0;
        for (const coin of items) {
            const x = Math.round(coin.x - cameraX);
            if (!visible(x) || slot >= COIN_SLOTS) continue;
            sprites.set(SPRITE_COINS + slot++, { x, y: coin.y + ((frame >> 3) % 2), pattern: 28, color: 10 });
        }
        while (slot < COIN_SLOTS) sprites.hide(SPRITE_COINS + slot++);
    }

    const app: App = {
        init(ctx) {
            const { screen, scroll, sprites, bgm, gfx } = ctx;
            screen.setMode("G4");
            screen.setPalette(PALETTE);
            screen.setBackdrop(0);
            screen.setDrawPage(0);
            gfx.now.clear(1);

            // 平面はページ2と3を並べた幅512。左端の8画素は隠す（細かい横スクロールで
            // 端がちらつくので）。帯は上から、点数（ページ0で止まったまま）、雲、丘、地面。
            scroll.wide = true;
            scroll.mask = true;
            scroll.split(0, { x: 0, y: 0, page: 0 });
            clouds = scroll.split(CLOUDS_TOP, { page: PLANE_PAGE });
            hills = scroll.split(HILLS_TOP, { page: PLANE_PAGE });
            field = scroll.split(FIELD_TOP, { page: PLANE_PAGE });

            scenery(ctx);
            restart(ctx);
            hud(ctx);

            sprites.setSize(16);
            // 主人公。数字は色。一行に三色なら一色は残り二色の OR（帽子の行は
            // 11 と 4 と 15。11|4 = 15）。パターンは立ちが 0 と 4、走りが 8 と 12。
            standing = sprites.setMulticolorPattern(0, [
                "......bbbb......", ".....bb4fbbb....",
                ".....c1cc1c.....", ".....cccccc.....",
                "......cccc......", "....bbbbbbbb....",
                "...bbbbbbbbbb...", "...c.dddddd.c...",
                "...c.dddddd.c...", ".....dddddd.....",
                ".....dd..dd.....", ".....dd..dd.....",
                ".....dd..dd.....", ".....dd..dd.....",
                "....999..999....", "................"
            ]);
            running = sprites.setMulticolorPattern(8, [
                "......bbbb......", ".....bb4fbbb....",
                ".....c1cc1c.....", ".....cccccc.....",
                "......cccc......", "....bbbbbbbb....",
                "...bbbbbbbbbb...", "..cc.dddddd.cc..",
                ".....dddddd.....", ".....dddddd.....",
                "....ddd..ddd....", "...ddd....ddd...",
                "..ddd......dd...", "..99.......999..",
                "................", "................"
            ]);
            sprites.setPatternFromBitmap(16, [                  // 敵・歩き1
                "................", "................",
                "................", ".....######.....",
                "...##########...", "..############..",
                "..##..####..##..", "..##..####..##..",
                "..############..", "..############..",
                "...##########...", "....########....",
                "...###....###...", "..###......###..",
                "................", "................"
            ]);
            sprites.setPatternFromBitmap(24, [                  // 敵・歩き2
                "................", "................",
                "................", ".....######.....",
                "...##########...", "..############..",
                "..##..####..##..", "..##..####..##..",
                "..############..", "..############..",
                "...##########...", "....########....",
                "....###..###....", "....###..###....",
                "................", "................"
            ]);
            sprites.setPatternFromBitmap(20, [                  // 敵・踏まれた
                "................", "................",
                "................", "................",
                "................", "................",
                "................", "................",
                "................", "................",
                "................", "..############..",
                ".##############.", ".##..######..##.",
                ".##############.", "................"
            ]);
            sprites.setPatternFromBitmap(28, [                  // コイン
                "................", "................",
                "................", "......####......",
                ".....######.....", "....##.#####....",
                "....##.#####....", "....##.#####....",
                "....##.#####....", "....##.#####....",
                ".....######.....", "......####......",
                "................", "................",
                "................", "................"
            ]);
            place(ctx);
            sprites.setActiveCount(SPRITE_COINS + COIN_SLOTS);

            bgm.play(theme, { loop: true });
        },

        update(ctx) {
            const { input } = ctx;
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
                // 終わったあとは少し見せてから、新しい地面で勝手にやり直す。
                if (--over === 0) restart(ctx);
                hud(ctx);
                return;
            }

            const hand = demo ? autopilot() : { move: axis.x, jump: input.btnp(BUTTON.A) };
            movePlayer(ctx, hand.move, hand.jump);
            if (player.blink > 0) player.blink--;
            moveEnemies(ctx);
            collect(ctx);

            // カメラは前にしか進まない。進んだ分だけ列を描き足し、帯を動かす。
            cameraX = Math.max(cameraX, Math.floor(player.x) - CAMERA_LEAD);
            stream(ctx);
            field.x = cameraX;
            hills.x = Math.floor(cameraX / 3);
            clouds.x = Math.floor(cameraX / 8 + frame / 6);

            place(ctx);
            hud(ctx);
        },

        draw({ screen, gfx }) {
            // 終わりの札だけ、そのとき一度描く。点数の帯の上なので動かない。
            if (over === 179) {
                screen.setDrawPage(0);
                gfx.now.fillRect(0, 0, 256, HUD_HEIGHT, 11);
                gfx.now.text(100, 4, "GAME OVER", 15);
            }
        }
    };
    return app;
};

export default create;
