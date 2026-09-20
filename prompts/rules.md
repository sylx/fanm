# 制作ルール

fanM は、fantasy-msx の上で動く MSX2 風の短い作品を作り続ける。作品は Web のギャラリーで、ブラウザ上の fantasy-msx によって再生される。

作品には型がある。環境デモ、操作できるゲーム、詩、アドベンチャー、RPG。どの型を作るかは毎回こちらが決めて渡す。型ごとの作法はそのときの手引きに書いてある。

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
- 絵は描画命令、`gfx.drawImage` に渡す 1 画素 1 バイトの配列、スプライトで作る。音は MML（`compile` と `ctx.bgm`）か PSG / OPLL の直接操作で作る。

## よくある間違い

実際に型検査で落ちたものばかり。**API 資料の型宣言にある名前だけを使う。無い名前を推測で呼ばない**（`?.` でごまかすと、その場は通っても何も起きない）。

- **`ctx` から使うものを分割代入する。** `update({ screen, gfx })` のように受け取る。関数の外で `screen` と書くと、ブラウザの `window.screen` として解釈され、`setColor` も `setMode` も無いと言われる。`gfx` や `sprites` を使う関数には `ctx` を渡す。
- **画面モードは `screen.setMode("G4")`。** 値は `"G4"`（SCREEN 5）、`"G5"`（SCREEN 6）、`"G6"`（SCREEN 7）、`"G7"`（SCREEN 8）。`"screen7"` や `"graphic7"` という値は無い。
- **時刻は `ctx.frame`。** `env` にあるのは `seed` と `random` だけで、`env.frame` は無い。
- **パレットは `screen.setColor(index, r, g, b)` か `screen.setPalette([[r,g,b], ...])`。** `setPaletteEntry` は Screen には無い。
- **スプライトは `ctx.sprites`。** `sprites.setPatternFromBitmap(n, [...])`、`sprites.set(n, {...})`、`sprites.move(n, x, y)`、`sprites.setActiveCount(n)`。`gfx` にスプライトの命令は無い。

## 操作できる作品

- 入力は `ctx.input` だけ。`input.axis()`、`input.btn(BUTTON.A)`、`input.btnp(BUTTON.UP)`（押した瞬間）、`input.btnr(...)`（離した瞬間）。生のキー（`input.key`）と `ctx.keyboard` は使わない。
- **誰も触らないうちから動いていること。** 機械が自分で遊ぶ、話が自分で進む、カーソルが自分で選ぶ。最初の入力が来たら人に渡し、しばらく触られなければまた自分で動き出す。
- `meta.json` の `controls` に操作を一行で書く。ギャラリーの作品名の横に出る。

## よい作品にするために

- 無操作でも 30〜60 秒楽しめること。操作できる作品も、開始操作を待たずに自動で見どころまで進む（デモプレイなど）。
- 最初の 1 秒以内に何かが見えること。`init` で `gfx.now` を使って最初の画面を出す。
- 時間とともに変化があること。ずっと同じ画面にしない。
- 描画の座標は整数で渡す。`Math.sin` / `Math.cos` で作った値はエンジンが最寄りの画素に丸めるが、自分で `Math.round` したほうが位置がはっきりする。
- **一度描いた絵は消えない。毎フレーム描き直さない。** 背景は `init` か、変わったときだけ描く。動くものはスプライトに任せる。画面全体の塗り直しを毎フレーム積むと、検査の時間切れで不採用になる（実測: 通った作品は1フレームの処理が 1ms 以下。2400〜3600フレームを120秒以内に走り切る必要がある）。
- blitter の描画は時間がかかる。大きな描画を毎フレーム積まない。`gfx.pending` を見て、溜まっていたら積むのを待つ。動くものはハードウェアスプライト（32 枚）に任せる。
- 画面の切れ目を見せたくないときは `screen.useDoubleBuffer()` と `screen.flip()` を使う。SCREEN 8（G7）はページが 1 枚しかないので二重化できない。
- 画面モード: G4 = SCREEN 5（256×212、16 色）、G5 = SCREEN 6（512×212、4 色）、G6 = SCREEN 7（512×212、16 色）、G7 = SCREEN 8（256×212、256 色固定）。パレットは 16 色のモードで `screen.setColor` / `setPalette`（各 0〜7 の 3 ビット）。
- 音があると作品がずっとよくなる。BGM は `ctx.bgm.play(compile([...]), { loop: true })`。
