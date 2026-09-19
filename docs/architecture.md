# 構成

fanM は二つの部分に分かれる。

- **バッチ処理**（`packages/batch`）— 作品を作る。chevron 上で Coolify が管理するコンテナとして常駐する。
- **ギャラリーサイト**（`packages/gallery`）— 作品を見せる。Cloudflare Workers で静的に配信する。

二つをつなぐのは作品形式（`packages/work`）とエンジン（`engine/fantasy-msx`）だけ。

```text
fanM/
├─ engine/fantasy-msx/     fantasy-msx（git submodule、コミット固定）
├─ packages/
│  ├─ work/                @fanm/work    作品形式。バッチ・ギャラリー・生成コードの共通の契約
│  ├─ batch/               @fanm/batch   バッチ処理（chevron / Coolify で常駐）
│  │  └─ src/
│  │     ├─ cli.ts         入口（fanm check / run / publish）
│  │     ├─ scheduler/     制作頻度。残予算と残日数から決める
│  │     ├─ budget/        予算台帳。予約と精算
│  │     ├─ jobs/          ジョブ状態。再開と重複防止
│  │     ├─ providers/     AI事業者への接続（依存はここに閉じ込める）
│  │     ├─ plan/          企画
│  │     ├─ generate/      生成と修正
│  │     ├─ check/         ビルド・実行・撮影・検査
│  │     ├─ archive/       作品庫（公開分と非公開の記録を分ける）
│  │     └─ publish/       公開先への接続
│  └─ gallery/             @fanm/gallery ギャラリーサイト（目録 + iframe プレイヤー、Cloudflare Workers）
├─ templates/minimal/      最小の作品。AIへの実例と結線確認を兼ねる
├─ prompts/                AIへ渡す制作ルールと資料
├─ config/                 設定の例。実設定 fanm.json は git に入れない
├─ docs/
└─ var/                    バッチの制作状態（git に入れない。本番では永続ボリューム）
   ├─ jobs/  ledger/  works/  queue/  logs/
   └─ check/               fanm check の撮影結果
```

## fantasy-msx の組み込み

- `engine/fantasy-msx` に submodule として置き、特定のコミットに固定する。
- エンジンの更新は `git -C engine/fantasy-msx checkout <commit>` を別のコミットとして行い、作品生成とは混ぜない。生成コードやバッチが submodule の中を書き換えることはない。
- fantasy-msx はパッケージとしてビルドされておらず、TypeScript のソースを直接読む形で使う。fanM 側では `fantasy-msx` → `engine/fantasy-msx/src/index.ts`、`fantasy-msx/*` → `engine/fantasy-msx/*` と別名を付けている（`tsconfig.base.json` の `paths`、`packages/gallery/vite.config.ts` の `alias`）。バッチは tsx で動かし、tsx が同じ `paths` を解決する。
- fantasy-msx 自身が持つ WebMSX の submodule は取得しない。チップのコードは `src/core/vendor/` に取り込み済みで、WebMSX は取り込み直すときにしか使わない。
- ヘッドレス撮影には fantasy-msx の `tools/capture.ts` と `tools/png.ts` を借りている。`src/` ではないので、エンジン側で動かされたら追従する。

## 作品形式

`packages/work/src/index.ts` が唯一の定義。

- `work.ts` は `(env: WorkEnv) => App` を default export する。起動ごとに状態を作り直せるよう、`App` を直接は出さない。
- 時刻はフレーム、乱数は `env.random`（seed 付き mulberry32）。
- `meta.json` のうち、AI が書くのは `WorkDescription`（タイトル、説明、操作、長さ）。id、日時、エンジンのコミット、seed、サムネイルはバッチが足す。

## 公開時の作品とエンジンの版

作品は fantasy-msx を外部依存としてビルドした `works/<id>/work.js` にする予定。エンジンは `engine/<commit>/` に版ごとに置き、プレイヤーは作品の `meta.engine` に合う版を import map で渡す。こうすればエンジンを更新しても過去作品はビルドし直さずに再生できる。未実装。

## 開発

```bash
git submodule update --init         # engine/fantasy-msx（WebMSX は不要）
npm install
npm run typecheck                   # fanM とエンジンのソースを合わせて型検査
npm run check:template              # 最小テンプレートをヘッドレスで動かし var/check/minimal に撮影
npm run gallery:dev                 # play.html?work=minimal でテンプレートを再生
```

## 現状

| 部分 | できていること | まだないもの |
| --- | --- | --- |
| バッチ | `fanm check`：作品をヘッドレスで動かして撮影する | AI呼出し、企画、生成・修正、予算台帳、ジョブ保存、常駐ループ、Dockerfile |
| ギャラリー | 目録ページと iframe プレイヤーの雛形。開発時は `templates/` の作品を再生できる | 実作品の読込（エンジンの版ごとの配信）、サムネイル、作品ごとのURL、Workers の設定 |
| つなぎ | 作品形式（`@fanm/work`） | 作品を Cloudflare へ届ける方式（Workers 再デプロイか R2 か）|
