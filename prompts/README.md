# prompts

AIへ渡す資料。バッチのコードとは分けて管理し、変更履歴を追えるようにする。

- `rules.md` — 制作ルール（作品形式、禁止事項、長さ、よい作品にするための指針）
- `api.md` — fantasy-msx の README 抜粋と公開APIの型宣言。`npm run prompts:api` で生成する。エンジンを更新したら作り直す
- `plan.md` — 企画の指示。`{{past}}` に過去作品の要約、`{{form}}` に今回の型の手引き（`templates/<型>/form.md`）、`{{twist}}` に今回の縛り（`plan/variations.ts` が引く）が入る
- `generate.md` — 生成の指示。`{{form}}`（型の手引き）、`{{plan}}`（企画）、`{{template}}`（`templates/<型>/work.ts` からデータを抜いたもの）、`{{avoid}}`（実例の名前と文章。使わせないため）が入る
- `repair.md` — 修正の指示。`{{stage}}`、`{{problems}}`、`{{observations}}` が入る

型ごとの手引きと実例は `prompts/` ではなく `templates/<型>/` にある。手引きと実例は同じ型の話なので、離すと片方だけ古くなる。

実例は `generate/example.ts` の `thin` でデータを抜いてから渡す。そのまま渡すと、AIは設定だけを変えた写しを返す。写しになっていないかは検査で測る（`check/overlap.ts`）。同じ型の中で段取りを変えさせるのは `plan/variations.ts` の縛り。

system メッセージは常に `rules.md` + `api.md`。先頭が揃うので、企画・生成・修正のどれでも入力キャッシュが効く。
