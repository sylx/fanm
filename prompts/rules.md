# 制作ルール

- 作品は `work.ts` と `meta.json` の二つ。`work.ts` は `WorkFactory` を default export する。
- import してよいのは `fantasy-msx` と `@fanm/work` の型だけ。他のパッケージ、`node:*`、`fetch`、DOM には触れない。
- 状態はすべて factory の中に置き、起動のたびに作り直す。
- 時刻はフレームで数える。`Date` や `performance.now()` を使わない。
- 乱数は `env.random` だけを使う。`Math.random` を使わない。
- 無操作でも 30〜60 秒楽しめること。操作できる作品も、開始操作を待ち続けず自動で見どころまで進む。
- 映像は描画コードとスプライト、音は MML や音源制御で作る。外部の画像・音声・APIに頼らない。
