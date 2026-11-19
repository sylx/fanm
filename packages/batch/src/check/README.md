# check

生成された作品を実際に動かして、採否と、AIへ返す所見を出す。入口は `check.ts` の `checkWork`。

1. `static.ts` — 禁止事項（`Math.random`、`Date`、`fetch`、許可外の import など）を文字列で検査
2. `overlap.ts` — 実例（`templates/<型>/work.ts`）と同じ型の過去作をどれだけ写しているか。語の並びの一致率が上限を超えたら不合格にして作り直させる
3. `typecheck.ts` — work.ts だけを対象に tsc
4. `isolated.ts` — esbuild で作品と `runner.ts` を一つの JS に束ね、node の permission model（読み書きは出力先だけ）、ヒープ上限、時間上限つきの子プロセスで実行
5. `runner.ts` + `headless.ts` — 子プロセスの中で fantasy-msx をヘッドレスで回し、5 時点を撮影
6. `stats.ts` — 撮影の数値（色数、最多色の割合、変化率）。DeepSeek V4 Pro は画像を読めないので、これを文章にして渡す
7. `images.ts` — 同梱の絵（`<dir>/images/<名前>.png`、D部門）。子プロセスの中で読んで `env.images` に渡す。`headless.ts` の `watchImages` が `ctx.image.reduce` と `drawImage` に割り込み、絵を減色したか・減色のあとに画面へ置いたかを数える。一枚も減色していない絵、減色しても何も置いていない作品は picture の段階で落とす

落とすのは明らかな不具合と、書き写しだけ（例外、時間切れ、ずっと一色、画面も音も止まっている、描画待ちが増え続ける、実例の写し、同梱した絵を出していない）。

TODO:
- 子プロセスのネットワークを塞ぐ（本番はコンテナのネットワーク設定で）
- ブラウザでの読込・描画確認
- 不採用作の保存期間と容量の上限
