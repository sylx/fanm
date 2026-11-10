// 対戦の実例。二台が盤の上を走り、通った跡が壁になる。先に壁へ突っ込んだほうが負け。
//
// この型で外してはいけないのは三つ。
//
//   1. 二人とも、誰も触らなければ機械が動かす。人が触った側だけ人に渡し、
//      しばらく触られなければまた機械に戻す。1P は input の 0、2P は 1。
//   2. 盤の状態は自分の配列に持つ。当たり判定は配列で取り、画面から読まない。
//   3. 描くのは変わった升だけ。一升進むたびに 4x4 の塗りを二つ。盤を丸ごと
//      描き直すのは回の切れ目だけで、それも blitter に任せて数フレームで終わる。
//
// 頭はスプライト。跡は gfx.now の小さな塗りで、描いたら消えない。

import { compile, opllVoice, psgVoice, rhythmVoice, type App, type Context, type Player } from "fantasy-msx";
import type { WorkFactory } from "@fanm/work";

const CELL = 4;              // 一升の大きさ（画素）
const COLS = 62;
const ROWS = 47;
const LEFT = 4;              // 盤の左上
const TOP = 6;
const STEP = 3;              // 何フレームで一升進むか
const MATCH = 3;             // 先に何回勝てば一試合が終わるか
const IDLE = 600;            // 人が離れてから機械に戻すまで（10秒）
const BOARD = 1;             // 盤の配列の値。0 は空き
const SCORE_Y = 200;
const AROUND = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** 一台。trail は跡の色、head は頭の色（どちらもパレットの番号）。 */
interface Rider {
    readonly player: Player;
    x: number;
    y: number;
    dx: number;
    dy: number;
    wantX: number;           // 次の一升で曲がりたい向き
    wantY: number;
    human: boolean;
    idle: number;
    wins: number;
    readonly mark: number;   // 盤の配列に書く値
    readonly trail: number;
    readonly head: number;
}

const create: WorkFactory = env => {
    let tick = 0;           // STEP ごとに進む
    let phase: "run" | "flash" | "wipe" | "won" = "run";
    let wait = 0;            // flash / won の残りフレーム
    let wiped = false;       // 盤を空ける塗りを積んだか
    let loser: Rider | null = null;
    let shown = "";

    const board = new Uint8Array(COLS * ROWS);
    // 機械が先を読むための作業場。毎回作らずに使い回す。
    const seen = new Uint16Array(COLS * ROWS);
    let stamp = 0;
    const queue = new Int16Array(COLS * ROWS);

    const riders: Rider[] = [
        { player: 0, x: 0, y: 0, dx: 1, dy: 0, wantX: 1, wantY: 0, human: false, idle: 0, wins: 0, mark: 2, trail: 2, head: 3 },
        { player: 1, x: 0, y: 0, dx: -1, dy: 0, wantX: -1, wantY: 0, human: false, idle: 0, wins: 0, mark: 3, trail: 4, head: 5 }
    ];

    const theme = compile([
        { voice: psgVoice(0), mml: "t150 v9 q5 l8 o4 [a r a > c < a r g e]4" },
        { voice: opllVoice(0), mml: "t150 @13 v10 l4 o2 [a a g e]4" },
        { voice: rhythmVoice(), mml: "t150 v10 l8 [c g d g c c d g]4" }
    ]);

    const free = (x: number, y: number) => x >= 0 && y >= 0 && x < COLS && y < ROWS && board[y * COLS + x] === 0;

    /** (x, y) から行ける空き升を、limit まで数える。広いほうへ曲がるために使う。 */
    function room(x: number, y: number, limit: number): number {
        if (!free(x, y)) return -1;
        stamp = (stamp + 1) & 0xffff || 1;
        let head = 0;
        let tail = 0;
        queue[tail++] = y * COLS + x;
        seen[y * COLS + x] = stamp;
        while (head < tail && tail < limit) {
            const at = queue[head++];
            const cx = at % COLS;
            const cy = (at - cx) / COLS;
            for (const [ox, oy] of AROUND) {
                const nx = cx + ox;
                const ny = cy + oy;
                if (!free(nx, ny) || seen[ny * COLS + nx] === stamp) continue;
                seen[ny * COLS + nx] = stamp;
                queue[tail++] = ny * COLS + nx;
            }
        }
        return tail;
    }

    /**
     * 機械の手。まっすぐ、左、右の三つを比べ、先に広い場所が残るほうへ行く。
     * 少しだけ乱数を混ぜる。いつも最善だと、毎回同じ形の跡になる。
     */
    function think(rider: Rider): void {
        const options = [[rider.dx, rider.dy], [rider.dy, -rider.dx], [-rider.dy, rider.dx]];
        let best = options[0];
        let bestScore = -1e9;
        options.forEach(([dx, dy], n) => {
            const open = room(rider.x + dx, rider.y + dy, 60);
            if (open < 0) return;
            const score = open + (n === 0 ? 6 : 0) + env.random() * 10;
            if (score > bestScore) {
                bestScore = score;
                best = [dx, dy];
            }
        });
        rider.wantX = best[0];
        rider.wantY = best[1];
    }

    /** 人の手。十字の向きを覚えておき、次の一升で曲がる。真後ろには曲がれない。 */
    function listen({ input }: Context, rider: Rider): void {
        const { x, y } = input.axis(rider.player);
        if (x !== 0 || y !== 0) {
            rider.human = true;
            rider.idle = 0;
            if (x !== 0 && rider.dx === 0) { rider.wantX = x; rider.wantY = 0; }
            else if (y !== 0 && rider.dy === 0) { rider.wantX = 0; rider.wantY = y; }
        } else if (rider.human && ++rider.idle > IDLE) {
            rider.human = false;
        }
    }

    function paint({ gfx }: Context, rider: Rider): void {
        gfx.now.fillRect(LEFT + rider.x * CELL, TOP + rider.y * CELL, CELL, CELL, rider.trail);
    }

    function place({ sprites }: Context): void {
        riders.forEach((rider, n) => {
            sprites.move(n, LEFT + rider.x * CELL - 2, TOP + rider.y * CELL - 2);
        });
    }

    /** 回の始まり。盤を空け、二台を左右の端に置く。 */
    function startRound(ctx: Context): void {
        board.fill(0);
        const row = 12 + Math.floor(env.random() * (ROWS - 24));
        Object.assign(riders[0], { x: 10, y: row, dx: 1, dy: 0, wantX: 1, wantY: 0 });
        Object.assign(riders[1], { x: COLS - 11, y: ROWS - 1 - row, dx: -1, dy: 0, wantX: -1, wantY: 0 });
        for (const rider of riders) {
            board[rider.y * COLS + rider.x] = rider.mark;
            paint(ctx, rider);
        }
        place(ctx);
        colors(ctx);
        loser = null;
        wiped = false;
        phase = "run";
        tick = 0;
    }

    function colors({ screen }: Context): void {
        screen.setColor(2, 1, 4, 7);   // 1P の跡
        screen.setColor(3, 5, 7, 7);   // 1P の頭
        screen.setColor(4, 7, 3, 1);   // 2P の跡
        screen.setColor(5, 7, 6, 4);   // 2P の頭
    }

    function frameBoard({ screen, gfx }: Context): void {
        screen.setColor(0, 0, 0, 1);
        screen.setColor(1, 2, 2, 3);
        screen.setColor(14, 4, 4, 5);
        screen.setColor(15, 7, 7, 7);
        gfx.now.clear(0);
        gfx.now.rect(LEFT - 2, TOP - 2, COLS * CELL + 4, ROWS * CELL + 4, 1);
    }

    /** 勝ち数。変わったときだけ描く。 */
    function score({ gfx }: Context): void {
        const label = (rider: Rider) =>
            `${rider.player + 1}P ${"*".repeat(rider.wins).padEnd(MATCH, "-")} ${rider.human ? "YOU" : "CPU"}`;
        const line = riders.map(label).join("|");
        if (line === shown) return;
        shown = line;
        gfx.now.fillRect(0, SCORE_Y, 256, 12, 0);
        gfx.now.text(LEFT, SCORE_Y + 2, label(riders[0]), riders[0].head);
        gfx.now.text(140, SCORE_Y + 2, label(riders[1]), riders[1].head);
    }

    /** 二台を一升ずつ進める。同時に動かすので、ぶつかりは進める前にまとめて調べる。 */
    function advance(ctx: Context): void {
        for (const rider of riders) {
            if (!rider.human) think(rider);
            rider.dx = rider.wantX;
            rider.dy = rider.wantY;
        }
        const next = riders.map(r => ({ x: r.x + r.dx, y: r.y + r.dy }));
        const crashed = riders.map((_, n) => !free(next[n].x, next[n].y));
        if (next[0].x === next[1].x && next[0].y === next[1].y) crashed[0] = crashed[1] = true;

        riders.forEach((rider, n) => {
            if (crashed[n]) return;
            rider.x = next[n].x;
            rider.y = next[n].y;
            board[rider.y * COLS + rider.x] = rider.mark;
            paint(ctx, rider);
        });
        place(ctx);

        if (crashed[0] || crashed[1]) {
            // 両方ぶつかったら引き分け。勝ち数は動かさない。
            if (crashed[0] !== crashed[1]) {
                loser = crashed[0] ? riders[0] : riders[1];
                (crashed[0] ? riders[1] : riders[0]).wins++;
            }
            phase = "flash";
            wait = 90;
            ctx.bgm.effect(psgVoice(2), "t150 v15 w8 l16 o2 c c < c");
        }
    }

    const app: App = {
        init(ctx) {
            const { screen, sprites, bgm } = ctx;
            screen.setMode("G4");
            frameBoard(ctx);

            sprites.setSize(8);
            sprites.setPatternFromBitmap(0, [
                "........", "..####..", ".######.", ".##..##.",
                ".##..##.", ".######.", "..####..", "........"
            ]);
            riders.forEach((rider, n) => sprites.set(n, { x: 0, y: 212, pattern: 0, color: rider.head }));
            sprites.setActiveCount(riders.length);

            startRound(ctx);
            score(ctx);
            bgm.play(theme, { loop: true });
        },

        update(ctx) {
            const { screen, gfx, bgm } = ctx;
            for (const rider of riders) listen(ctx, rider);

            if (phase === "run") {
                if (++tick % STEP === 0) advance(ctx);
            } else if (phase === "flash") {
                // 負けた側の跡を点滅させる。描き直さず、パレットだけ。
                if (loser) {
                    const on = (wait >> 3) % 2 === 0;
                    screen.setColor(loser.trail, on ? 7 : 1, on ? 7 : 1, on ? 7 : 1);
                }
                if (--wait === 0) {
                    const champion = riders.find(r => r.wins >= MATCH);
                    if (champion) {
                        phase = "won";
                        wait = 150;
                        gfx.now.fillRect(80, 92, 96, 20, 0);
                        gfx.now.rect(80, 92, 96, 20, champion.head);
                        gfx.now.text(104, 98, `${champion.player + 1}P WINS`, champion.head);
                        bgm.effect(psgVoice(2), "t150 v14 l16 o5 c e g > c");
                    } else {
                        phase = "wipe";
                    }
                }
            } else if (phase === "won") {
                if (--wait === 0) {
                    for (const rider of riders) rider.wins = 0;
                    phase = "wipe";
                }
            } else if (phase === "wipe" && wiped && !gfx.busy) {
                // 盤を空けるのは blitter に任せた。描き終わってから次の回へ。
                startRound(ctx);
            }
            score(ctx);
        },

        draw({ gfx }) {
            // 盤を空ける塗りは一度だけ積む。偶数の座標なので数フレームで終わり、
            // 上から消えていくのが見える。
            if (phase === "wipe" && !wiped) {
                gfx.fillRect(LEFT, TOP, COLS * CELL, ROWS * CELL, 0);
                wiped = true;
            }
        }
    };
    return app;
};

export default create;
