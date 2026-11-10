// 楽曲の実例。曲が主役で、絵は曲そのものから作る。
//
// この型で外してはいけないのは二つ。
//
//   1. 絵の出どころは楽譜。compile が返した Song の events を、ドライバと同じ
//      数え方で毎フレーム追いかける（follow）。何が今鳴っているかを、絵の側で
//      推し量ったり、別に時刻表を持ったりしない。曲を書き換えれば絵もついてくる。
//   2. 毎フレームの仕事は、画面の右端に入ってくる一列だけ。画面全体は
//      ctx.scroll で左へ送る。描き直しは一列ぶんの縦線と、鳴っている声の点だけ。
//
// 曲は部分ごとに compile し、一つ終わったら次を bgm.play で掛ける。部分が
// 替わるたびに、声の色と下の帯の文字が替わる。

import { compile, opllVoice, psgVoice, rhythmVoice, type App, type Context, type Track, type TrackSource } from "fantasy-msx";
import type { WorkFactory } from "@fanm/work";

const ROLL_BOTTOM = 192;     // ここより上が流れる譜面。下は止まった帯
const LOW = 33;              // 譜面の一番下に来る音（A2）
const RISE = 3;              // 半音ごとに上がる画素
const TEMPO = 120;
const BEAT = 3600 / TEMPO;   // 四分音符のフレーム数
const BAR = BEAT * 4;
const GRID = 1;              // 拍の点の色。打楽器で光らせる

/** 曲の部分。どれも同じ小節数にそろえる。 */
interface Part {
    readonly name: string;
    readonly tracks: readonly TrackSource[];
    /** 声ごとの色 [r, g, b]。部分が替わると塗り直さずに色だけ替わる。 */
    readonly colors: readonly (readonly [number, number, number])[];
}

const PARTS: readonly Part[] = [
    {
        name: "INTRO",
        tracks: [
            { voice: opllVoice(0), mml: `t${TEMPO} @14 v11 l4 o2 [a a > c < a f f g g]2` },
            { voice: rhythmVoice(), mml: `t${TEMPO} v12 l8 [c g d g c c d g]4` }
        ],
        colors: [[2, 3, 7], [0, 0, 0], [0, 0, 0], [0, 0, 0]]
    },
    {
        name: "THEME",
        tracks: [
            { voice: opllVoice(0), mml: `t${TEMPO} @14 v11 l4 o2 [a a > c < a f f g g]2` },
            { voice: psgVoice(0), mml: `t${TEMPO} v11 q6 l8 o5 [e4 a4 g e d4 c d e4 r2]2` },
            { voice: psgVoice(1), mml: `t${TEMPO} v8 q3 l8 o4 [a > c < a > c < f a f a g b g b e g e g]2` },
            { voice: rhythmVoice(), mml: `t${TEMPO} v12 l8 [c g d g c c d g]4` }
        ],
        colors: [[2, 3, 7], [7, 6, 2], [3, 6, 3], [0, 0, 0]]
    },
    {
        name: "BRIDGE",
        tracks: [
            { voice: opllVoice(0), mml: `t${TEMPO} @14 v11 l2 o2 [f g e a]2` },
            { voice: psgVoice(0), mml: `t${TEMPO} v11 q7 l4 o5 c. o4 b8 a g a1 o5 d. c8 o4 b g e1` },
            { voice: psgVoice(2), mml: `t${TEMPO} v9 q8 l2 o4 [a > c < b > e <]2` },
            { voice: rhythmVoice(), mml: `t${TEMPO} v10 l4 [c g c {dg}]4` }
        ],
        colors: [[1, 2, 6], [7, 4, 5], [0, 0, 0], [6, 7, 7]]
    },
    {
        name: "THEME",
        tracks: [
            { voice: opllVoice(0), mml: `t${TEMPO} @14 v11 l4 o2 [a a > c < a f f g g]2` },
            { voice: psgVoice(0), mml: `t${TEMPO} v12 q6 l8 o5 [e4 a4 g e d4 c d e4 r2]2` },
            { voice: psgVoice(1), mml: `t${TEMPO} v8 q3 l8 o4 [a > c < a > c < f a f a g b g b e g e g]2` },
            { voice: psgVoice(2), mml: `t${TEMPO} v9 q8 l1 o4 [a f g e]` },
            { voice: rhythmVoice(), mml: `t${TEMPO} v12 l8 [c g d g c c {dg} {cf}]4` }
        ],
        colors: [[3, 4, 7], [7, 7, 3], [4, 7, 4], [7, 5, 6]]
    }
];

/** 声の並び。色の番号はこの順に 2, 3, 4, 5。明るい頭の色は 10, 11, 12, 13。 */
const VOICES = ["opll0", "psg0", "psg1", "psg2"] as const;

/** 一つの声を、ドライバと同じ数え方で追う。 */
interface Follower {
    readonly track: Track;
    readonly lane: number;   // VOICES の何番か。打楽器は -1
    cursor: number;
    remaining: number;
    gate: number;            // 鳴っている残り
    semitone: number;        // 鳴っている音。鳴っていなければ -1
    struck: boolean;         // このフレームで鳴り始めたか
    done: boolean;
}

const create: WorkFactory = () => {
    let frame = 0;
    let part = -1;
    let partFrame = 0;
    let followers: Follower[] = [];
    let flash = 0;           // 打楽器で光った拍の点の明るさ
    let roll: { x: number } = { x: 0 };

    const songs = PARTS.map(p => compile(p.tracks));

    function laneOf(track: Track): number {
        const { voice } = track;
        if (voice.chip === "rhythm") return -1;
        return VOICES.indexOf(`${voice.chip}${voice.channel}` as (typeof VOICES)[number]);
    }

    /** 次の部分を掛ける。追う側もそろって最初から。 */
    function nextPart({ screen, gfx, bgm }: Context): void {
        part = (part + 1) % PARTS.length;
        partFrame = 0;
        bgm.play(songs[part], { loop: false });
        followers = songs[part].tracks.map(track => ({
            track, lane: laneOf(track), cursor: 0, remaining: 0, gate: 0, semitone: -1, struck: false, done: false
        }));
        PARTS[part].colors.forEach(([r, g, b], n) => {
            screen.setColor(2 + n, r >> 1, g >> 1, b >> 1);
            screen.setColor(10 + n, r, g, b);
        });
        // 下の帯の文字。部分が替わったときだけ描く。
        gfx.now.fillRect(0, ROLL_BOTTOM + 4, 256, 12, 0);
        gfx.now.text(8, ROLL_BOTTOM + 6, `${String(part + 1).padStart(2, "0")} ${PARTS[part].name}`, 15);
    }

    /** 一フレーム進める。SoundDriver の advance と同じ順で読む。 */
    function follow(f: Follower): void {
        f.struck = false;
        if (f.done) return;
        while (f.remaining === 0) {
            if (f.cursor >= f.track.events.length) {
                f.done = true;
                f.semitone = -1;
                return;
            }
            const event = f.track.events[f.cursor++];
            if (event.type === "note") {
                f.semitone = event.semitone;
                f.remaining = event.frames;
                f.gate = Math.max(1, Math.floor((event.frames * event.gate) / 8));
                f.struck = true;
            } else if (event.type === "rest") {
                f.semitone = -1;
                f.gate = 0;
                f.remaining = event.frames;
            } else if (event.type === "drum") {
                f.remaining = event.frames;
                f.struck = true;
                // バスドラム（c）が入っていれば強く、ほかは弱く光らせる。
                flash = Math.max(flash, event.mask & 16 ? 7 : 4);
            }
        }
        if (f.gate > 0 && --f.gate === 0) f.semitone = -1;
        f.remaining--;
    }

    const pitchY = (semitone: number) => Math.max(4, Math.min(ROLL_BOTTOM - 4, ROLL_BOTTOM - 6 - (semitone - LOW) * RISE));

    const app: App = {
        init(ctx) {
            const { screen, scroll, gfx, sprites } = ctx;
            screen.setMode("G4");
            screen.setColor(0, 0, 0, 1);
            screen.setColor(GRID, 1, 1, 2);
            screen.setColor(14, 2, 2, 3);
            screen.setColor(15, 6, 6, 7);
            gfx.now.clear(0);
            gfx.now.hline(0, ROLL_BOTTOM + 1, 256, 14);

            // 上の帯を流し、下の帯は止める。どちらもページ0。
            roll = scroll.split(0, { page: 0 });
            scroll.split(ROLL_BOTTOM, { page: 0, x: 0 });
            scroll.mask = true;

            // 声ごとの頭。今鳴っている高さに、右の端で光る。
            sprites.setSize(8);
            sprites.setPatternFromBitmap(0, [
                "...#....", "..###...", ".#####..", "#######.",
                ".#####..", "..###...", "...#....", "........"
            ]);
            VOICES.forEach((_, n) => sprites.set(n, { x: 0, y: 212, pattern: 0, color: 10 + n }));
            sprites.setActiveCount(VOICES.length);

            nextPart(ctx);
        },

        update(ctx) {
            const { screen, sprites } = ctx;
            frame++;
            partFrame++;
            for (const f of followers) follow(f);
            if (followers.every(f => f.done)) nextPart(ctx);

            // 譜面を一画素ずつ左へ。描いたものは動かさない。
            roll.x = frame & 255;

            if (flash > 0) {
                screen.setColor(GRID, flash, flash, Math.min(7, flash + 1));
                flash = Math.max(1, flash - 1);
                if (flash === 1) {
                    screen.setColor(GRID, 1, 1, 2);
                    flash = 0;
                }
            }

            VOICES.forEach((_, lane) => {
                const f = followers.find(x => x.lane === lane);
                if (f && f.semitone >= 0) sprites.move(lane, 244, pitchY(f.semitone) - 3);
                else sprites.move(lane, 0, 212);
            });
        },

        draw({ gfx }) {
            // 右の端に入ってくる一列。左の端から出ていった列と同じ場所なので、
            // まず消してから描く。
            const column = (roll.x + 255) & 255;
            gfx.now.vline(column, 0, ROLL_BOTTOM, 0);
            if (partFrame % BEAT === 0) {
                const bar = partFrame % BAR === 0;
                for (let y = 4; y < ROLL_BOTTOM; y += bar ? 4 : 12) gfx.now.pixel(column, y, GRID);
            }
            for (const f of followers) {
                if (f.lane < 0 || f.semitone < 0) continue;
                const y = pitchY(f.semitone);
                // 鳴り始めは明るい色で縦に長く、伸びている間は暗い色で細く。
                if (f.struck) gfx.now.vline(column, y - 2, 5, 10 + f.lane);
                else gfx.now.vline(column, y, 2, 2 + f.lane);
            }
        }
    };
    return app;
};

export default create;
