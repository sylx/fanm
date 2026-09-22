// 縦スクロールシューティングの実例。海と島の上を北へ飛び、降りてくる編隊を撃つ。
//
// この型の勘どころは、地上を描き直さずに流すこと。
//
//   1. 地上は描いたまま動かさない。ctx.scroll の y で「どこから見るか」を動かす。
//      縦の平面は256行の輪で、画面（212行）より44行大きい。これから画面の上端に
//      入ってくる行は、いつもその見えていない44行のどこかにあるので、そこへ
//      一行ずつ描き足す。一フレームに一行だけなので、ほとんど只で流れる。
//   2. 見えていない44行は、平面の212〜255行目に来ることがある。gfx はふだん画面の
//      高さ（212行）で止まるので、init で gfx.offscreen = true にしておく。
//   3. 画面の上端の点数の帯は scroll.split でページ0に分け、止めておく。地上は
//      ページ1（G6 / G7 にはページが二枚しかないので、2 ではなく 1）。スプライトの Y は画面の行で渡せばよい（縦スクロールの分はエンジンが
//      足す）。点数の帯には sprites: false を付ける。付けないと、地上のスプライトが
//      点数の帯に幽霊のように映る（帯ごとに y が違うため）。付けておけば、上から
//      入ってくる敵も点数の帯の下から滑り出てくる。
//   4. 動くもの（自機、弾、敵）はすべてスプライト。一行に並べられるのは8枚まで。
//
// 誰も触らなくても遊びが進むこと。最初は機械が自分で避け、撃つ。

import { BUTTON, compile, opllVoice, psgVoice, type App, type Context, type ScrollBand } from "fantasy-msx";
import type { WorkFactory } from "@fanm/work";

const HUD_HEIGHT = 12;
const FIELD_TOP = HUD_HEIGHT;       // ここから下が地上
const SCREEN_BOTTOM = 212;
/** 縦の平面の高さ。R23 は8ビットなので、画面の高さにかかわらず256で一周する。 */
const PLANE_HEIGHT = 256;
const PLANE_PAGE = 1;

const PLAYER_SPEED = 2;
const SHOT_SPEED = 6;

// スプライトの割り当て。
const SPRITE_PLAYER = 0;
const SPRITE_SHOTS = 1;
const SHOT_SLOTS = 4;
const SPRITE_ENEMIES = SPRITE_SHOTS + SHOT_SLOTS;
const ENEMY_SLOTS = 8;
const SPRITE_BULLETS = SPRITE_ENEMIES + ENEMY_SLOTS;
const BULLET_SLOTS = 8;

// 地上の色。番号は PALETTE の並び。
const DEEP = 1, SEA = 2, SHALLOW = 3, SAND = 4, GRASS = 5, FOREST = 6, ROCK = 7;

/** 16色。各 0〜7。2 と 3 は海のきらめきで入れ替える。 */
const PALETTE: [number, number, number][] = [
    [0, 0, 0], [0, 1, 3], [0, 2, 5], [1, 4, 6],
    [6, 6, 3], [2, 5, 1], [1, 3, 0], [4, 4, 3],
    [1, 1, 2], [7, 7, 7], [7, 7, 3], [7, 2, 2],
    [6, 3, 7], [7, 5, 7], [7, 5, 1], [7, 7, 7]
];

interface Shot { x: number; y: number }

interface Enemy {
    kind: "drifter" | "diver";
    x: number;
    y: number;
    vx: number;
    vy: number;
    home: number;           // drifter が揺れる中心
    burst: number;          // 0 より大きいと爆発中。残りフレーム
}

interface Bullet { x: number; y: number; vx: number; vy: number }

const create: WorkFactory = env => {
    let frame = 0;
    let score = 0;
    let lives = 3;
    let shown = "";
    let over = 0;
    let demo = true;
    let idle = 0;

    let distance = 0;               // 進んだ行数。地上の世界の行でもある
    let painted = -1;               // 平面に描いた一番先の行
    let field: ScrollBand;

    let player = { x: 120, y: 176, blink: 0 };
    let shots: Shot[] = [];
    let enemies: Enemy[] = [];
    let bullets: Bullet[] = [];
    let waves: { at: number; kind: Enemy["kind"]; x: number }[] = [];

    const theme = compile([
        { voice: psgVoice(0), mml: "t132 v10 q6 l16 o5 [e8 e g a8 g e d8 d e g8 e d]2 [c8 c e g8 e c <b8 b >d g8 d <b>]" },
        { voice: psgVoice(1), mml: "t132 v8 q5 l8 o3 [a a >c <a g g b g]2 [f f a f g g b g]" },
        { voice: opllVoice(0), mml: "t132 @3 v9 l2 o3 [a g]2 [f g]" }
    ]);

    // --- 地上 --------------------------------------------------------------

    /** 格子点ごとの決まった乱数。種から決まるので、同じ作品は同じ島になる。 */
    const salt = Math.floor(env.random() * 0x7fffffff);
    function hash(ix: number, iy: number): number {
        let h = (ix * 374761393 + iy * 668265263 + salt) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }

    /** 滑らかな起伏。格子点の乱数を、なだらかにつないだもの。 */
    function noise(x: number, y: number): number {
        const ix = Math.floor(x), iy = Math.floor(y);
        const fx = x - ix, fy = y - iy;
        const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
        const top = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * u;
        const bottom = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * u;
        return top + (bottom - top) * v;
    }

    /** 世界の (x, 行) の色。行が進むと、海ばかりの所と島の多い所が交互に来る。 */
    function colorAt(x: number, row: number): number {
        const tide = 0.12 * Math.sin(row / 300);
        const h = noise(x / 48, row / 48) * 0.7 + noise(x / 12, row / 12) * 0.3 + tide;
        if (h < 0.36) return DEEP;
        if (h < 0.47) return hash(x, row) < 0.02 ? SHALLOW : SEA;          // 白波の粒
        if (h < 0.51) return SHALLOW;
        if (h < 0.55) return SAND;
        if (h < 0.7) return GRASS;
        if (h < 0.84) return FOREST;
        return ROCK;
    }

    /**
     * 世界の行 row を平面に描く。行は平面の下から上へ並べる（row が一つ進むと
     * 平面の行は一つ戻る）。同じ色が続く所は一本の横線にまとめる。
     * 212行目より下にも描くので、gfx.offscreen を立てておくこと。
     */
    function paintRow({ screen, gfx }: Context, row: number): void {
        const line = (PLANE_HEIGHT - 1 - row) & 255;
        screen.setDrawPage(PLANE_PAGE);
        let start = 0;
        let color = colorAt(0, row);
        for (let x = 1; x <= 256; ++x) {
            const next = x < 256 ? colorAt(x, row) : -1;
            if (next === color) continue;
            gfx.now.hline(start, line, x - start, color);
            start = x;
            color = next;
        }
    }

    /** 画面の上端に入ってくる行まで描いておく。ふだんは一フレームに一行。 */
    function stream(ctx: Context): void {
        const top = distance + (SCREEN_BOTTOM - 1 - FIELD_TOP) + 2;
        while (painted < top) paintRow(ctx, ++painted);
    }

    /**
     * 縦スクロール。画面の最下行に世界の行 distance が来るようにする。帯の y は
     * 「画面の一番上の行に平面のどの行を出すか」（R23 と同じ意味）。
     */
    function aim(): void {
        field.y = (PLANE_HEIGHT - SCREEN_BOTTOM - distance) & 255;
    }

    /** 点数の帯（ページ0、止まったまま）。変わったときだけ描き直す。 */
    function hud({ screen, gfx }: Context): void {
        const text = over > 0 ? "GAME OVER" : `SCORE ${String(score).padStart(6, "0")}   SHIPS ${"A".repeat(Math.max(0, lives))}`;
        if (text === shown) return;
        shown = text;
        screen.setDrawPage(0);
        gfx.now.fillRect(0, 0, 256, HUD_HEIGHT, 8);
        gfx.now.text(8, 2, text, over > 0 ? 11 : 15);
    }

    // --- 空 ----------------------------------------------------------------

    /** 編隊を一つ予約する。少しずつ間を空けて、同じ所から降りてくる。 */
    function planWave(): void {
        const kind: Enemy["kind"] = env.random() < 0.5 ? "drifter" : "diver";
        const x = 32 + Math.floor(env.random() * 176);
        const count = kind === "drifter" ? 5 : 3;
        for (let n = 0; n < count; ++n) waves.push({ at: frame + n * 14, kind, x: kind === "diver" ? x + n * 20 - 20 : x });
    }

    function spawn(kind: Enemy["kind"], x: number): void {
        if (enemies.length >= ENEMY_SLOTS) return;                          // 出せる枚数を超えて作らない
        enemies.push({ kind, x, y: -16, vx: 0, vy: kind === "drifter" ? 1.2 : 1.6, home: x, burst: 0 });
    }

    function fire(from: { x: number; y: number }, speed: number): void {
        const dx = player.x - from.x, dy = player.y - from.y;
        const length = Math.max(1, Math.hypot(dx, dy));
        bullets.push({ x: from.x, y: from.y + 8, vx: dx / length * speed, vy: dy / length * speed });
    }

    function moveEnemies(): void {
        for (const enemy of enemies) {
            if (enemy.burst > 0) {
                enemy.burst--;
                continue;
            }
            if (enemy.kind === "drifter") {
                enemy.y += enemy.vy;
                enemy.x = enemy.home + Math.sin(enemy.y / 18) * 40;
            } else {
                // 途中で自機の方へ向きを変え、速くなる。
                if (enemy.y > 70 && enemy.vx === 0) {
                    enemy.vx = Math.sign(player.x - enemy.x) * 1.2;
                    enemy.vy = 2.6;
                }
                enemy.x += enemy.vx;
                enemy.y += enemy.vy;
            }
            if (enemy.y > FIELD_TOP && enemy.y < 140 && env.random() < 0.012) fire(enemy, 2);
        }
        enemies = enemies.filter(e => (e.burst === 0 || e.burst > 1) && e.y < SCREEN_BOTTOM && e.x > -16 && e.x < 256);
    }

    function hit(ctx: Context): void {
        for (const shot of shots) {
            for (const enemy of enemies) {
                if (enemy.burst || Math.abs(shot.x - enemy.x) > 12 || Math.abs(shot.y - enemy.y) > 12) continue;
                enemy.burst = 16;
                shot.y = -99;
                score += enemy.kind === "diver" ? 150 : 100;
                ctx.bgm.effect(psgVoice(2), "t132 v13 w8 l32 o4 c <g");
            }
        }
        shots = shots.filter(s => s.y > -16);

        if (player.blink > 0 || over > 0) return;
        const touched = enemies.some(e => !e.burst && Math.abs(e.x - player.x) < 10 && Math.abs(e.y - player.y) < 10)
            || bullets.some(b => Math.abs(b.x - player.x - 4) < 6 && Math.abs(b.y - player.y - 4) < 6);
        if (!touched) return;
        ctx.bgm.effect(psgVoice(2), "t132 v15 w20 l8 o2 c");
        lives--;
        bullets = [];
        if (lives <= 0) over = 180;
        player = { x: 120, y: 176, blink: 120 };
    }

    /**
     * 機械の手。一番近い敵の真下へ寄り、上から来る弾が近ければ横へ逃げる。
     * 撃つのは止めない。うまい必要はない。
     */
    function autopilot(): { x: number; y: number } {
        const danger = bullets.find(b => b.y < player.y + 8 && player.y - b.y < 40 && Math.abs(b.x - player.x - 4) < 16);
        if (danger) return { x: danger.x < player.x + 4 ? 1 : -1, y: 0 };
        const target = enemies.filter(e => !e.burst).sort((a, b) => b.y - a.y)[0];
        const dx = target ? target.x - player.x : 120 - player.x;
        return { x: Math.abs(dx) < 3 ? 0 : Math.sign(dx), y: player.y < 170 ? 1 : player.y > 180 ? -1 : 0 };
    }

    function restart(): void {
        score = 0;
        lives = 3;
        over = 0;
        enemies = [];
        bullets = [];
        shots = [];
        waves = [];
        player = { x: 120, y: 176, blink: 60 };
    }

    /** スプライトは画面の行で置く。点数の帯に掛かった分は、帯が隠してくれる。 */
    function visible(y: number): boolean {
        return y > -16 && y < SCREEN_BOTTOM;
    }

    function place({ sprites }: Context): void {
        if (over > 0 || (player.blink > 0 && (frame >> 2) % 2 === 0)) sprites.hide(SPRITE_PLAYER);
        else sprites.set(SPRITE_PLAYER, { x: Math.round(player.x), y: Math.round(player.y), pattern: 0, color: 9 });

        for (let n = 0; n < SHOT_SLOTS; ++n) {
            const shot = shots[n];
            if (shot && visible(shot.y)) sprites.set(SPRITE_SHOTS + n, { x: shot.x, y: Math.round(shot.y), pattern: 4, color: 10 });
            else sprites.hide(SPRITE_SHOTS + n);
        }
        for (let n = 0; n < ENEMY_SLOTS; ++n) {
            const enemy = enemies[n];
            if (!enemy || !visible(enemy.y)) {
                sprites.hide(SPRITE_ENEMIES + n);
                continue;
            }
            const pattern = enemy.burst ? 16 : enemy.kind === "drifter" ? 8 : 12;
            const color = enemy.burst ? 14 : enemy.kind === "drifter" ? 11 : 12;
            sprites.set(SPRITE_ENEMIES + n, { x: Math.round(enemy.x), y: Math.round(enemy.y), pattern, color });
        }
        for (let n = 0; n < BULLET_SLOTS; ++n) {
            const bullet = bullets[n];
            if (bullet && visible(bullet.y)) sprites.set(SPRITE_BULLETS + n, { x: Math.round(bullet.x), y: Math.round(bullet.y), pattern: 20, color: 13 });
            else sprites.hide(SPRITE_BULLETS + n);
        }
    }

    const app: App = {
        init(ctx) {
            const { screen, scroll, sprites, bgm, gfx } = ctx;
            screen.setMode("G4");
            screen.setPalette(PALETTE);
            screen.setBackdrop(0);

            // 平面の212〜255行目にも描き足すので、gfx が画面の下まで届くようにする。
            gfx.offscreen = true;
            // 帯は二つ。上の点数の帯はページ0で止め、スプライトは出さない。地上はページ1。
            scroll.split(0, { x: 0, y: 0, page: 0, sprites: false });
            field = scroll.split(FIELD_TOP, { page: PLANE_PAGE });
            stream(ctx);
            aim();
            hud(ctx);

            sprites.setSize(16);
            sprites.setPatternFromBitmap(0, [                   // 自機
                ".......##.......", ".......##.......",
                "......####......", "......####......",
                "......#..#......", ".....######.....",
                "..#..########..#", "..##.########.##",
                "..##############", "..##############",
                "..#...######...#", ".......####.....",
                "......######....", ".....##.##.##...",
                "................", "................"
            ]);
            sprites.setPatternFromBitmap(4, [                   // 自機の弾
                "................", "................",
                "......#..#......", "......#..#......",
                "......#..#......", "......#..#......",
                "......#..#......", "................",
                "................", "................",
                "................", "................",
                "................", "................",
                "................", "................"
            ]);
            sprites.setPatternFromBitmap(8, [                   // 揺れて降りる敵
                "................", "..##........##..",
                "..###......###..", "...###....###...",
                "....########....", "...##########...",
                "..###.####.###..", "..############..",
                "...##########...", "....##....##....",
                "...##......##...", "................",
                "................", "................",
                "................", "................"
            ]);
            sprites.setPatternFromBitmap(12, [                  // 突っ込んでくる敵
                "................", "......####......",
                ".....######.....", "....##.##.##....",
                "....########....", "...##########...",
                "..####....####..", ".###........###.",
                ".##..........##.", "................",
                "................", "................",
                "................", "................",
                "................", "................"
            ]);
            sprites.setPatternFromBitmap(16, [                  // 爆発
                "......#...#.....", "..#...##.##..#..",
                "...##.#####.##..", "....#########...",
                "..###########...", ".#####.###.####.",
                "..####.....###..", ".######...#####.",
                "..###########...", "...##########...",
                "..##.#######.#..", ".#...##.###...#.",
                "......#..#......", "................",
                "................", "................"
            ]);
            sprites.setPatternFromBitmap(20, [                  // 敵の弾
                "................", "................",
                "................", "................",
                "................", "......##........",
                ".....####.......", ".....####.......",
                "......##........", "................",
                "................", "................",
                "................", "................",
                "................", "................"
            ]);
            place(ctx);
            sprites.setActiveCount(SPRITE_BULLETS + BULLET_SLOTS);

            bgm.play(theme, { loop: true });
        },

        update(ctx) {
            const { input, screen, bgm } = ctx;
            frame++;

            const axis = input.axis();
            const trigger = input.btn(BUTTON.A) || input.btn(BUTTON.B);
            if (axis.x !== 0 || axis.y !== 0 || trigger) {
                demo = false;
                idle = 0;
            } else if (!demo && ++idle > 600) {
                demo = true;
            }

            // 地上は一フレームに一行進む。描くのは入ってくる一行だけ。
            distance++;
            stream(ctx);
            aim();
            // 海のきらめきは色の入れ替えだけ。地上には触らない。
            if (frame % 20 === 0) {
                const [a, b] = (frame / 20) % 2 ? [PALETTE[SEA], PALETTE[SHALLOW]] : [PALETTE[SHALLOW], PALETTE[SEA]];
                screen.setColor(SEA, a[0], a[1], a[2]);
                screen.setColor(SHALLOW, b[0], b[1], b[2]);
            }

            if (over > 0 && --over === 0) restart();

            // 自機。機械か人かで、動かし方だけが違う。
            if (over === 0) {
                const hand = demo ? autopilot() : axis;
                player.x = Math.max(0, Math.min(240, player.x + hand.x * PLAYER_SPEED));
                player.y = Math.max(FIELD_TOP + 40, Math.min(SCREEN_BOTTOM - 16, player.y + hand.y * PLAYER_SPEED));
                if (player.blink > 0) player.blink--;
                if ((demo || trigger) && frame % 8 === 0 && shots.length < SHOT_SLOTS) {
                    shots.push({ x: Math.round(player.x), y: player.y - 8 });
                    bgm.effect(psgVoice(2), "t132 v9 l64 o6 c");
                }
            }
            for (const shot of shots) shot.y -= SHOT_SPEED;

            if (frame % 100 === 1 && over === 0) planWave();
            for (const wave of waves) if (wave.at === frame) spawn(wave.kind, wave.x);
            waves = waves.filter(w => w.at > frame);

            moveEnemies();
            for (const bullet of bullets) {
                bullet.x += bullet.vx;
                bullet.y += bullet.vy;
            }
            bullets = bullets.filter(b => b.y < SCREEN_BOTTOM && b.x > -8 && b.x < 256).slice(0, BULLET_SLOTS);

            hit(ctx);
            place(ctx);
            hud(ctx);
        }
    };
    return app;
};

export default create;
