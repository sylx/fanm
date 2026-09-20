// 詩の実例。日本語を一字ずつ置いていく。
//
// 日本語は内蔵フォントに無い。ctx.text（ホストのフォント）を @fanm/work の
// DOT_STYLE で使うと、エンジン同梱の 12x10 ドットの面で組める。ギャラリーでは
// プレイヤーがその面を先に読み、検査では同じ面から取り出したドットが並ぶ。
//
// 一字ずつ出すのは、そのほうが安いからでもある。drawNow は描いた絵をその場で
// VRAM へ置き、あとは消すまで残る。だから毎フレームの仕事は「今の一字」だけ。
// 行を丸ごと描き直してはいけない。
//
// 読む時間を与えること。一行を出し終えてから、少なくとも3秒は消さない。

import { compile, opllVoice, psgVoice, type App, type Context } from "fantasy-msx";
import { DOT_STYLE, type WorkFactory } from "@fanm/work";

/** 詩。自分で書く。一行は全角20字まで（256画素 ÷ 12画素）。 */
const STANZAS: readonly (readonly string[])[] = [
    ["みずのうえに ゆきがふる", "とけるまでの みじかい みち", "あかりは とおく", "だれも かぞえない"],
    ["よるが ふかくなるほど", "こおりは しずかに のびて", "あさには すべてを", "わすれている"]
];

const TEXT_TOP = 56;         // 一行目のベースラインの上
const LINE_STEP = 24;        // 行と行の間
const TYPE_EVERY = 5;        // 何フレームに一字
const HOLD = 240;            // 一連を出し終えてから消すまで（4秒）

const create: WorkFactory = env => {
    let frame = 0;

    // どこまで書いたか。stanza が今の連、line が今の行、char が今の字。
    let stanza = 0;
    let line = 0;
    let char = 0;
    let pen = 0;             // 今の行の、次の字を置く x
    let wait = 90;           // 次の字までの休み。最初は少し置いてから書き始める

    /** 雪。スプライトなので、落ちても跡が残らない。 */
    const flakes = Array.from({ length: 12 }, () => ({
        x: Math.floor(env.random() * 256),
        y: Math.floor(env.random() * 212),
        speed: 1 + Math.floor(env.random() * 2),
        drift: env.random() < 0.5 ? -1 : 1
    }));

    const theme = compile([
        { voice: psgVoice(0), mml: "t72 v8 q4 l4 o5 [c r e r  g r e r]2" },
        { voice: opllVoice(0), mml: "t72 @6 v9 l1 o3 [c f  <a+>g]" }
    ]);

    /** 水辺の夜。init で一度だけ描く。あとはパレットだけが動く。 */
    function scene({ screen, gfx }: Context): void {
        screen.setColor(0, 0, 0, 1);      // 空
        screen.setColor(1, 0, 1, 2);      // 遠くの岸
        screen.setColor(2, 0, 0, 3);      // 水
        screen.setColor(3, 1, 2, 4);      // 波
        screen.setColor(4, 5, 5, 3);      // 灯り
        screen.setColor(15, 7, 7, 6);     // 文字

        gfx.now.clear(0);
        gfx.now.fillRect(0, 140, 256, 8, 1);
        gfx.now.fillRect(0, 148, 256, 64, 2);
        // さざなみ。行ごとに位置と長さを変えて、水面を平らに見せない。
        for (let y = 152; y < 212; y += 6) {
            gfx.now.hline((y * 37) % 210, y, 16 + (y * 7) % 40, 3);
            gfx.now.hline((y * 91) % 180, y + 2, 8 + (y * 3) % 24, 2);
        }
        gfx.now.fillRect(196, 132, 3, 10, 4);          // 対岸の灯り
        gfx.now.fillRect(194, 150, 7, 2, 4);           // その映り込み
    }

    /** 書いた字を消す。連の切れ目にだけ通る。 */
    function clearText({ gfx }: Context): void {
        gfx.now.fillRect(0, TEXT_TOP - 14, 256, LINE_STEP * 4 + 8, 0);
    }

    const app: App = {
        init(ctx) {
            const { screen, sprites, text, bgm } = ctx;
            screen.setMode("G4");
            scene(ctx);

            // 字の組み方を一度だけ決める。以後は色だけ渡す。
            text.style = DOT_STYLE;

            sprites.setSize(8);
            sprites.setPatternFromBitmap(0, [
                "..##....", ".####...", "..##....", "........",
                "........", "........", "........", "........"
            ]);
            flakes.forEach((flake, n) => sprites.set(n, { x: flake.x, y: flake.y, pattern: 0, color: 15 }));
            sprites.setActiveCount(flakes.length);

            bgm.play(theme, { loop: true });
        },

        update(ctx) {
            const { sprites } = ctx;
            frame++;

            flakes.forEach((flake, n) => {
                flake.y += flake.speed;
                flake.x += (frame % 32 < 16 ? flake.drift : 0);
                if (flake.y > 212) {
                    flake.y = -8;
                    flake.x = Math.floor(env.random() * 256);
                }
                sprites.move(n, (flake.x + 256) % 256, flake.y);
            });

            // 水の色をゆっくり呼吸させる。描画はしない。
            if (frame % 8 === 0) {
                const breath = 2 + Math.floor(Math.abs(Math.sin(frame / 240)) * 2);
                ctx.screen.setColor(3, 1, breath, 5);
            }

            if (wait > 0) {
                wait--;
                return;
            }

            const lines = STANZAS[stanza];
            if (line >= lines.length) {
                // 一連を読み終えた。消して、次の連へ。
                clearText(ctx);
                stanza = (stanza + 1) % STANZAS.length;
                line = 0;
                char = 0;
                pen = 0;
                wait = 90;
                return;
            }

            const source = [...lines[line]];
            if (char >= source.length) {
                line++;
                char = 0;
                pen = 0;
                wait = line >= lines.length ? HOLD : 72;   // 行間は1.2秒、連の終わりは4秒
                return;
            }

            // 一字だけ置く。行の残りは、次のフレームからの仕事。
            const glyph = source[char];
            const y = TEXT_TOP + line * LINE_STEP;
            ctx.text.drawNow(16 + pen, y, glyph, { color: 15 });
            pen += ctx.text.measure(glyph).width;
            char++;
            wait = glyph === " " ? 1 : TYPE_EVERY;
        }
    };
    return app;
};

export default create;
