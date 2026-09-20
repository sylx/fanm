// アドベンチャーゲームの実例。上に一枚絵、下に文章の枠。
//
// この型は、画面の作法そのものが本体。枠は init で一度だけ描き、以後は
// 中身だけを入れ替える。一枚絵も場面が変わるときにだけ描く。毎フレーム
// 描き直すものは何もない。
//
// 文章は一字ずつ置く（text.drawNow）。日本語は内蔵フォントに無いので、
// @fanm/work の DOT_STYLE を ctx.text に渡して組む。
//
// 無操作でも話が最後まで進み、最初へ戻る。選択肢は、待っていれば自分で選ぶ。
// 操作するなら ↑↓ で選び、トリガで決める。

import { BUTTON, compile, opllVoice, psgVoice, type App, type Context } from "fantasy-msx";
import { DOT_STYLE, type WorkFactory } from "@fanm/work";

const VIEW = { x: 8, y: 8, width: 240, height: 108 };      // 一枚絵
const WINDOW = { x: 8, y: 128, width: 240, height: 76 };   // 文章の枠
const TEXT_X = WINDOW.x + 10;
const TEXT_Y = WINDOW.y + 12;
const LINE_STEP = 16;
/** 選択肢を出す行。枠には4行しか入らないので、本文は2行までにしてここを空ける。 */
const CHOICE_Y = TEXT_Y + 2 * LINE_STEP;
const TYPE_EVERY = 3;        // 何フレームに一字
const READ_TIME = 150;       // 読み終わってから次へ行くまで
const CHOOSE_TIME = 300;     // 選択肢を自分で選ぶまで

/** 一つの場面。絵と、出す文と、行き先。 */
interface Scene {
    readonly paint: (ctx: Context) => void;
    readonly lines: readonly string[];
    readonly choices?: readonly string[];
    /** 選んだ番号（選択肢がなければ 0）から、次の場面の番号へ。 */
    readonly next: (choice: number) => number;
}

const create: WorkFactory = env => {
    let frame = 0;
    let scene = 0;
    let line = 0;
    let char = 0;
    let pen = 0;
    let wait = 60;
    let cursor = 0;
    let choosing = 0;        // 0 より大きいと、選択肢を出して待っている
    let typing = true;

    const theme = compile([
        { voice: psgVoice(0), mml: "t88 v9 q5 l8 o5 [e r g r  a r g r]2 [d r f r  g r f r]2" },
        { voice: psgVoice(1), mml: "t88 v7 q7 l2 o3 [e a]2 [d g]2" },
        { voice: opllVoice(0), mml: "t88 @5 v9 l1 o3 [e d]2" }
    ]);

    /** 絵の下地。場面ごとに呼び、上に何を足すかは場面が決める。 */
    function wash({ gfx }: Context, color: number): void {
        gfx.now.fillRect(VIEW.x, VIEW.y, VIEW.width, VIEW.height, color);
    }

    const SCENES: readonly Scene[] = [
        {
            paint(ctx) {
                const { gfx } = ctx;
                wash(ctx, 1);
                gfx.now.fillCircle(200, 36, 12, 10);                       // 月
                gfx.now.fillRect(VIEW.x, 86, VIEW.width, 30, 2);           // 地面
                gfx.now.fillRect(96, 40, 64, 46, 4);                       // 門
                gfx.now.fillRect(108, 56, 16, 30, 0);
                gfx.now.fillRect(132, 56, 16, 30, 0);
                gfx.now.rect(96, 40, 64, 46, 15);
            },
            lines: ["まよなかの もんの まえに いる。", "とびらは わずかに ひらいている。"],
            next: () => 1
        },
        {
            paint(ctx) {
                const { gfx } = ctx;
                wash(ctx, 0);
                // 奥行き。中心へ向かう線を何本か引くだけで廊下になる。
                for (let n = 0; n <= 6; ++n) {
                    const x = VIEW.x + n * 40;
                    gfx.now.line(x, VIEW.y, 128, 62, 8);
                    gfx.now.line(x, VIEW.y + VIEW.height, 128, 62, 8);
                }
                gfx.now.rect(112, 48, 32, 28, 4);                          // 突き当たりの扉
                gfx.now.fillRect(112, 48, 32, 28, 1);
            },
            lines: ["ながい ろうかが つづいている。", "つきあたりに もう ひとつの とびら。"],
            next: () => 2
        },
        {
            paint(ctx) {
                const { gfx } = ctx;
                wash(ctx, 1);
                gfx.now.fillRect(56, 24, 60, 44, 6);                       // 窓
                gfx.now.rect(56, 24, 60, 44, 15);
                gfx.now.line(86, 24, 86, 68, 15);
                gfx.now.line(56, 46, 116, 46, 15);
                gfx.now.fillRect(150, 70, 70, 8, 4);                       // 机
                gfx.now.fillRect(158, 78, 6, 26, 4);
                gfx.now.fillRect(206, 78, 6, 26, 4);
                gfx.now.fillRect(176, 60, 8, 10, 10);                      // 机の上の燭台
            },
            lines: ["へやには つくえが ひとつ。", "つくえの うえで ひが ゆれている。"],
            choices: ["ひを もっていく", "そのままにする"],
            next: choice => (choice === 0 ? 3 : 4)
        },
        {
            paint(ctx) {
                const { gfx } = ctx;
                wash(ctx, 0);
                gfx.now.fillCircle(128, 62, 40, 6);                        // 燭台の明かり
                gfx.now.fillCircle(128, 62, 24, 10);
                gfx.now.fillCircle(128, 62, 10, 11);
                gfx.now.fillRect(VIEW.x, 100, VIEW.width, 16, 4);
            },
            lines: ["ひを かかげると、もやが ひらいた。", "みちは そとへ つづいている。"],
            next: () => 5
        },
        {
            paint(ctx) {
                const { gfx } = ctx;
                wash(ctx, 0);
                gfx.now.fillRect(VIEW.x, 96, VIEW.width, 20, 1);
                // 暗い場面ほど、何か一つは形を置く。真っ黒は「止まっている」に見える。
                gfx.now.fillRect(112, 44, 28, 52, 2);                      // 廊下に立つ影
                gfx.now.fillCircle(126, 40, 9, 2);
                for (let n = 0; n < 5; ++n) gfx.now.pixel(40 + n * 44, 30 + (n % 3) * 12, 15);
            },
            lines: ["ひを おいて へやを でた。", "やみの なかで、なにかが うしろを とおった。"],
            next: () => 5
        },
        {
            paint(ctx) {
                const { gfx } = ctx;
                wash(ctx, 5);
                gfx.now.fillRect(VIEW.x, VIEW.y, VIEW.width, 40, 6);       // 明けてきた空
                gfx.now.fillRect(VIEW.x, 88, VIEW.width, 28, 2);
                gfx.now.fillCircle(128, 84, 16, 10);                       // のぼる日
            },
            lines: ["もんを でると、よるが あけていた。", "また おなじ よるが くる まで。"],
            next: () => 0
        }
    ];

    /** 枠。init で一度だけ。二重線にすると、あの時代の画面になる。 */
    function frames({ gfx }: Context): void {
        gfx.now.rect(VIEW.x - 2, VIEW.y - 2, VIEW.width + 4, VIEW.height + 4, 15);
        gfx.now.rect(WINDOW.x, WINDOW.y, WINDOW.width, WINDOW.height, 15);
        gfx.now.rect(WINDOW.x + 2, WINDOW.y + 2, WINDOW.width - 4, WINDOW.height - 4, 14);
    }

    /** 文章欄の中だけを消す。枠は残す。 */
    function clearWindow({ gfx }: Context): void {
        gfx.now.fillRect(WINDOW.x + 4, WINDOW.y + 4, WINDOW.width - 8, WINDOW.height - 8, 0);
    }

    /** 場面を出しなおす。絵と文章の両方。 */
    function enter(ctx: Context): void {
        SCENES[scene].paint(ctx);
        clearWindow(ctx);
        line = 0;
        char = 0;
        pen = 0;
        typing = true;
        choosing = 0;
        cursor = 0;
        wait = 20;
    }

    /** 選択肢とカーソル。選び直すたびに、印だけを描きかえる。 */
    function drawChoices(ctx: Context): void {
        const choices = SCENES[scene].choices ?? [];
        choices.forEach((choice, n) => {
            const y = CHOICE_Y + n * LINE_STEP;
            ctx.gfx.now.fillRect(TEXT_X - 8, y, 10, 12, 0);
            ctx.gfx.now.text(TEXT_X - 8, y + 2, n === cursor ? ">" : " ", 14);
            ctx.text.drawNow(TEXT_X + 8, y, choice, { color: 15 });
        });
    }

    const app: App = {
        init(ctx) {
            const { screen, text, bgm } = ctx;
            screen.setMode("G4");
            screen.setColor(0, 0, 0, 0);
            screen.setColor(1, 0, 0, 2);
            screen.setColor(2, 1, 1, 1);
            screen.setColor(4, 3, 2, 1);
            screen.setColor(5, 2, 2, 4);
            screen.setColor(6, 4, 4, 5);
            screen.setColor(10, 7, 6, 2);
            screen.setColor(11, 7, 7, 5);
            ctx.gfx.now.clear(0);
            text.style = DOT_STYLE;
            frames(ctx);
            enter(ctx);
            bgm.play(theme, { loop: true });
        },

        update(ctx) {
            const { input } = ctx;
            frame++;

            const pressed = input.btnp(BUTTON.A) || input.btnp(BUTTON.B);

            if (choosing > 0) {
                // 選択肢。待っていれば自分で選ぶ。触られたらその指示で。
                if (input.btnp(BUTTON.UP) || input.btnp(BUTTON.DOWN)) {
                    cursor = (cursor + 1) % (SCENES[scene].choices?.length ?? 1);
                    drawChoices(ctx);
                }
                if (--choosing === 0 || pressed) {
                    scene = SCENES[scene].next(cursor);
                    enter(ctx);
                }
                return;
            }

            if (!typing) {
                // 読む時間。押されたら待たずに進む。
                if (--wait > 0 && !pressed) return;
                if (SCENES[scene].choices) {
                    choosing = CHOOSE_TIME;
                    drawChoices(ctx);
                    return;
                }
                scene = SCENES[scene].next(0);
                enter(ctx);
                return;
            }

            if (wait > 0 && !pressed) {
                wait--;
                return;
            }

            const lines = SCENES[scene].lines;
            const source = [...lines[line]];
            if (char >= source.length) {
                line++;
                char = 0;
                pen = 0;
                if (line >= lines.length) {
                    typing = false;
                    wait = READ_TIME;
                }
                return;
            }

            // 押されている間は一気に出す。待っている人を待たせない。
            const glyphs = pressed ? source.length - char : 1;
            for (let n = 0; n < glyphs; ++n) {
                const glyph = source[char + n];
                ctx.text.drawNow(TEXT_X + pen, TEXT_Y + line * LINE_STEP, glyph, { color: 15 });
                pen += ctx.text.measure(glyph).width;
            }
            char += glyphs;
            wait = TYPE_EVERY;

            // 語りの音。一字ごとではうるさいので、数字に一度。
            if (frame % 12 === 0 && env.random() < 0.5) ctx.bgm.effect(psgVoice(2), "t88 v6 l64 o6 c");
        }
    };
    return app;
};

export default create;
