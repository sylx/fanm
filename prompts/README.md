# prompts

AIへ渡す資料。バッチのコードとは分けて管理し、変更履歴を追えるようにする。

- `rules.md` — 制作ルール（作品形式、禁止事項、長さ、よい作品にするための指針）
- `api.md` — fantasy-msx の README 抜粋と公開APIの型宣言。`npm run prompts:api` で生成する。エンジンを更新したら作り直す
- `plan.md` — 企画の指示。`{{past}}` に過去作品の要約が入る
- `generate.md` — 生成の指示。`{{plan}}` と `{{template}}`（`templates/minimal/work.ts`）が入る
- `repair.md` — 修正の指示。`{{stage}}`、`{{problems}}`、`{{observations}}` が入る

system メッセージは常に `rules.md` + `api.md`。先頭が揃うので、企画・生成・修正のどれでも入力キャッシュが効く。
