# 制作ルール

fanM は、fantasy-msx の上で動く MSX2 風の短い作品を作り続ける。作品は Web のギャラリーで、ブラウザ上の fantasy-msx によって再生される。

作品には型がある。環境デモ、操作できるゲーム、詩、アドベンチャー、RPG、横スクロールアクション、縦スクロールシューティング、キャラクタ画面。どの型を作るかは毎回こちらが決めて渡す。型ごとの作法はそのときの手引きに書いてある。

## 作品の形

作品は `work.ts` と `meta.json` の二つ。

```ts
// work.ts
import { type App } from "fantasy-msx";          // 値の import も可: { BUTTON, compile, psgVoice, ... }
import { DOT_STYLE, type WorkFactory } from "@fanm/work";   // DOT_STYLE は日本語を出すときだけ

const create: WorkFactory = env => {
    // 状態はすべてここに置く。起動のたびに作り直される。
    const app: App = {
        init(ctx) { /* 画面モード、パレット、最初の画面、BGM の開始 */ },
        update(ctx) { /* 毎フレームの計算。ctx.frame が時刻 */ },
        draw(ctx) { /* 描画を積む */ }
    };
    return app;
};
export default create;
```

```json
// meta.json
{
  "title": "作品名",
  "description": "ギャラリーに出す説明。日本語で1〜3文。",
  "controls": "操作できる作品なら操作方法。できなければ空文字",
  "durationFrames": 2400
}
```

`durationFrames` は、無操作で見どころを一通り見せるのにかかるフレーム数（60 フレームで 1 秒）。1800〜3600 にする。

`controls` に何か書いた作品は、検査でも実際に操作される。最初の10秒は無操作のまま動かし、そのあと十字とトリガをでたらめに押す。どちらでも壊れないこと。

## 守ること

- import してよいのは `fantasy-msx` と `@fanm/work` だけ。
- 状態はすべて factory の中に置く。モジュールの最上位に変わる状態を置かない。
- 時刻はフレームで数える（`ctx.frame`、自前のカウンタ）。`Date`、`performance`、`setTimeout`、`setInterval`、`requestAnimationFrame` は使わない。
- 乱数は `env.random()` だけを使う。`Math.random` は使わない。
- 外部と通信しない。`fetch` などは使わない。`window`、`document`、`globalThis`、`process` などホストの環境に触れない。
- `ctx.image`（画像読込）、`ctx.console`、`ctx.ime`、`ctx.keyboard`、`ctx.crt` は使わない。
- 文字は二通り。**ASCII は `gfx.text` / `gfx.now.text`**（内蔵の 6x8 フォント。速い）。**日本語は `ctx.text`**。
  - `text.style = DOT_STYLE`（`@fanm/work`）を一度渡してから、`text.drawNow(x, y, "…", { color: 15 })` で描く。
  - `DOT_STYLE` の中身（font、size、stretch、snap、lineHeight）は変えない。この面には一つの大きさしかない。
  - `text.load` / `text.ready` は呼ばない。面はギャラリーのプレイヤーが先に読んでいる。
  - 日本語を `gfx.text` に渡してはいけない。`?` が並ぶだけになる。
  - このドット面は 512 画素のモード（G5 / G6）では崩れる。日本語を出すなら G4 か G7。
  - キャラクタ画面（G1 / G2 / G3）には `gfx` も `ctx.text` も無い。文字は `tiles.loadFont()` のあと `tiles.print` / `NameBuffer.print` で置く。ASCII だけ。
- 絵は描画命令、`gfx.drawImage` に渡す 1 画素 1 バイトの配列、スプライト、キャラクタ（`ctx.tiles`。G1〜G3 だけ）で作る。音は MML（`compile` と `ctx.bgm`）か PSG / OPLL の直接操作で作る。

## よくある間違い

実際に型検査で落ちたものばかり。**API 資料の型宣言にある名前だけを使う。無い名前を推測で呼ばない**（`?.` でごまかすと、その場は通っても何も起きない）。

- **`ctx` から使うものを分割代入する。** `update({ screen, gfx })` のように受け取る。関数の外で `screen` と書くと、ブラウザの `window.screen` として解釈され、`setColor` も `setMode` も無いと言われる。`gfx` や `sprites` を使う関数には `ctx` を渡す。
- **画面モードは `screen.setMode("G4")`。** 値は `"G4"`（SCREEN 5）、`"G5"`（SCREEN 6）、`"G6"`（SCREEN 7）、`"G7"`（SCREEN 8）、キャラクタ画面の `"G1"`（SCREEN 1）、`"G2"`（SCREEN 2）、`"G3"`（SCREEN 4）。`"screen7"` や `"graphic7"` という値は無い。
- **時刻は `ctx.frame`。** `env` にあるのは `seed` と `random` だけで、`env.frame` は無い。
- **パレットは `screen.setColor(index, r, g, b)` か `screen.setPalette([[r,g,b], ...])`。** `setPaletteEntry` は Screen には無い。
- **スプライトは `ctx.sprites`。** `sprites.setPatternFromBitmap(n, [...])`、`sprites.set(n, {...})`、`sprites.move(n, x, y)`、`sprites.setActiveCount(n)`。多色は `sprites.setMulticolorPattern(n, [...])` が返したものを `sprites.setMulticolor(n, { x, y, pattern })` に渡す。`gfx` にスプライトの命令は無い。
- **キャラクタは `ctx.tiles`。** `system.pcg` や `createSystem()` は使わない（作品には渡っていない）。`NameBuffer` は `fantasy-msx` から import して `new NameBuffer()` で作る。`tiles` の命令は G1 / G2 / G3 でしか動かず、G4〜G7 で呼ぶとエラーになる。逆に `gfx` は G1〜G3 でエラーになる。

## 操作できる作品

- 入力は `ctx.input` だけ。`input.axis()`、`input.btn(BUTTON.A)`、`input.btnp(BUTTON.UP)`（押した瞬間）、`input.btnr(...)`（離した瞬間）。生のキー（`input.key`）と `ctx.keyboard` は使わない。
- **誰も触らないうちから動いていること。** 機械が自分で遊ぶ、話が自分で進む、カーソルが自分で選ぶ。最初の入力が来たら人に渡し、しばらく触られなければまた自分で動き出す。
- `meta.json` の `controls` に操作を一行で書く。ギャラリーの作品名の横に出る。

## よい作品にするために

- 無操作でも 30〜60 秒楽しめること。操作できる作品も、開始操作を待たずに自動で見どころまで進む（デモプレイなど）。
- 最初の 1 秒以内に何かが見えること。`init` で `gfx.now` を使って最初の画面を出す（キャラクタ画面なら `tiles.transfer`）。
- 時間とともに変化があること。ずっと同じ画面にしない。
- 描画の座標は整数で渡す。`Math.sin` / `Math.cos` で作った値はエンジンが最寄りの画素に丸めるが、自分で `Math.round` したほうが位置がはっきりする。
- **一度描いた絵は消えない。毎フレーム描き直さない。**（G4〜G7 の話。キャラクタ画面 G1〜G3 は `NameBuffer` で毎フレーム丸ごと作り直してよい。768バイトなので待ちは出ない） 背景は `init` か、変わったときだけ描く。動くものはスプライトに任せる。画面全体の塗り直しを毎フレーム積むと、検査の時間切れで不採用になる（実測: 通った作品は1フレームの処理が 1ms 以下。2400〜3600フレームを120秒以内に走り切る必要がある）。
- **スプライトは多色にできる。** 一枚のスプライトは一行一色だが、`sprites.setMulticolorPattern(枠, ["..4466..", ...])`（16進の数字が色、`.` が透明）で色つきの絵を渡すと、エンジンが二枚に分けて重ねる。一行に三色まで使え、**三色なら一色は残り二色の OR**（2 と 4 と 6、8 と 7 と 15）。二色までならどの色でもよい。パレットを自分で決めるなら、OR の色を縁取りや光の色にしておくと映える。多色は二枚分を数える（番号 n と n+1、パターンも二組）ので、一行8枚の制限にすぐ届く。主人公や大きな敵に使い、弾や小物は一色のままにする。動かすのは `sprites.move(n, …)` か、絵を替えるなら毎回 `sprites.setMulticolor`。`sprites.set(n, …)` を呼ぶと重ねが外れる。G1 / G2 のスプライトは一枚一色で、多色はエラーになる。
- blitter の描画は時間がかかる。大きな描画を毎フレーム積まない。`gfx.pending` を見て、溜まっていたら積むのを待つ。動くものはハードウェアスプライト（32 枚）に任せる。
- 画面の切れ目を見せたくないときは `screen.useDoubleBuffer()` と `screen.flip()` を使う。
- **ページの数はモードで違う。** G4 / G5 は 0〜3 の 4 枚、G6 / G7 は 0 と 1 の 2 枚だけ（G1〜G3 のページは名前表で、0〜7 の 8 枚）。無いページ番号を渡してもエラーにならず、枚数で割った余りのページになる（G7 の `setDrawPage(2)` や `split(..., { page: 2 })` はページ 0）。API 資料の例にある `page: 2` は G4 向けなので、G6 / G7 でそのまま使わない。G6 / G7 でスコア表示の帯と縦スクロールする帯を分けるなら、スクロールする側をページ 1 に置き、スコア表示をページ 0 に置く。同じページに置くと、スクロールで一周したときにスコア表示が流れてくる。G6 / G7 で `scroll.wide` を使うと平面がページ 0 と 1 を両方使うので、ほかに使えるページは残らない。
- 画面モード: G1 = SCREEN 1、G2 = SCREEN 2、G3 = SCREEN 4（どれも 32×24 文字のキャラクタ画面、256×192）、G4 = SCREEN 5（256×212、16 色）、G5 = SCREEN 6（512×212、4 色）、G6 = SCREEN 7（512×212、16 色）、G7 = SCREEN 8（256×212、256 色固定）。G5 / G6 の `gfx` の座標は横 0〜511 で、画面の幅いっぱいは 512 画素。256 で止めると画面の右半分が空く（「論理幅は 256」ではない）。スプライトの x だけはどのモードでも 0〜255 で画面の幅いっぱい。パレットは 16 色のモードで `screen.setColor` / `setPalette`（各 0〜7 の 3 ビット）。
- **音は必ず付ける。無音の作品は作らない。** 音があると作品がずっとよくなる。BGM は `ctx.bgm.play(compile([...]), { loop: true })`。
