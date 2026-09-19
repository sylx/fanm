# check

生成された作品を実際に動かす。

- `headless.ts` — fantasy-msx のヘッドレス実行、フレーム送り、入力注入、撮影
- TODO: 型・ビルド検査（tsc / esbuild）
- TODO: 隔離実行（子プロセス、時間・メモリ上限、強制終了）
- TODO: ブラウザでの読込・描画確認
- TODO: 描画待ち（`gfx.pending`）の増大、素材の読込失敗の検出
