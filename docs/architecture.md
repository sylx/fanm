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
│  │     ├─ cli.ts         入口（fanm run / make / check / status / publish）
│  │     ├─ run/           常駐の輪、鍵、ログ、覚え書き、知らせ
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
├─ templates/<型>/         作品の型ごとの手引き（form.md）と実例（work.ts）。AIへ渡すものであり、結線確認も兼ねる
├─ prompts/                AIへ渡す制作ルールと資料
├─ config/                 設定の例。実設定 fanm.json は git に入れない
├─ wrangler.jsonc          公開先（Worker 名と fanm.oyabanare.com）。置き場所は publish が渡す
├─ docs/
└─ var/                    バッチの制作状態（git に入れない。本番では永続ボリューム）
   ├─ jobs/  ledger/  works/  queue/  logs/
   └─ check/               fanm check の撮影結果
```

## fantasy-msx の組み込み

- `engine/fantasy-msx` に submodule として置き、特定のコミットに固定する。
- エンジンの更新は `git -C engine/fantasy-msx checkout <commit>` を別のコミットとして行い、作品生成とは混ぜない。生成コードやバッチが submodule の中を書き換えることはない。更新したら `npm run engine:pin`（固定コミットを `engine/COMMIT` に控え直す。コンテナはそれを読む）。
- fantasy-msx はパッケージとしてビルドされておらず、TypeScript のソースを直接読む形で使う。fanM 側では `fantasy-msx` → `engine/fantasy-msx/src/index.ts`、`fantasy-msx/*` → `engine/fantasy-msx/*` と別名を付けている（`tsconfig.base.json` の `paths`、`packages/gallery/vite.config.ts` の `alias`）。バッチは tsx で動かし、tsx が同じ `paths` を解決する。
- fantasy-msx 自身が持つ WebMSX の submodule は取得しない。チップのコードは `src/core/vendor/` に取り込み済みで、WebMSX は取り込み直すときにしか使わない。
- ヘッドレス撮影には fantasy-msx の `tools/capture.ts` と `tools/png.ts` を借りている。`src/` ではないので、エンジン側で動かされたら追従する。

## 作品の型（`templates/`）

企画のたびに、作る型を一つ決めてから AI に渡す。型を決めずに頼むと、何を作っても環境デモに寄るため。

| 型 | ディレクトリ | 中身 |
| --- | --- | --- |
| 環境デモ | `templates/ambient/` | 操作のない映像。パレットとスプライトで動かす |
| ゲーム | `templates/game/` | 遊べるもの。無操作のときは機械が自分で遊ぶ |
| 詩 | `templates/poem/` | 日本語の詩が一字ずつ現れる |
| アドベンチャー | `templates/adventure/` | 上が一枚絵、下が文章の枠。選択肢で進む |
| RPG | `templates/rpg/` | 地図を歩き、戦いの画面でコマンドを選ぶ |

- 型ごとに `form.md`（AIへの手引き）、`work.ts`、`meta.json` を置く。型を増やすのは、ディレクトリを足して `plan/forms.ts` に一行足すだけ。
- 選ぶのは `plan/forms.ts` の `pickForm`。直近15作の型を数え、少ないものから当てる。同数なら乱択。AIには選ばせない。
- 選んだ型の `form.md` は企画（`plan.md` の `{{form}}`）と生成（`generate.md` の `{{form}}`）の両方に入り、`work.ts` が生成の実例（`{{template}}`）になる。
- ジョブには型が残る（`job.form`）ので、途中で落ちて再開しても同じ型で続く。

## 日本語の文字

内蔵フォント（`gfx.text`）は ASCII しか持たない。日本語は `ctx.text`（ホストのフォント）で組む。

- 面はエンジン同梱の `JF-Dot-k12x10.woff2`。ギャラリーでは vite の `publicDir` でそのまま配り、プレイヤーが作品を動かす前に読んで登録する。
- 書式は `@fanm/work` の `DOT_STYLE`（size 10 / stretch 1 / snap）。この面が決めている値で、選べるものではない。
- ヘッドレスの検査にはブラウザが無い。エンジンの `text.rasteriser` を差し替え口として、同じ woff2 から取り出したドット表（`check/dot-font.ts`、`packages/batch/src/generate/dot-font.py` が生成）を並べる（`check/typeset.ts`）。検査で見える字とギャラリーで見える字が同じになる。

## 作品形式

`packages/work/src/index.ts` が唯一の定義。

- `work.ts` は `(env: WorkEnv) => App` を default export する。起動ごとに状態を作り直せるよう、`App` を直接は出さない。
- 時刻はフレーム、乱数は `env.random`（seed 付き mulberry32）。
- `meta.json` のうち、AI が書くのは `WorkDescription`（タイトル、説明、操作、長さ）。id、日時、エンジンのコミット、seed、サムネイルはバッチが足す。

## 公開物の組み立て（`fanm publish`）

毎回すべてを作り直さない。作品もエンジンも、一度ビルドしたらそのまま置いておく。

```text
var/site/                        これがそのまま公開する中身
├─ index.html, assets/           ギャラリーの殻（gallery のビルドを写す。滅多に変わらない）
├─ play.html                     プレイヤー
├─ engine/<commit>.js            エンジン。コミットごとに一つ（213KB）
├─ works/<id>/work.js            作品。エンジンを含まず 3KB 程度
├─ works/<id>/thumb.png          サムネイル
└─ works/index.json              目録。新しい順。毎回書き直す（小さい）
```

- 作品は `import { ... } from "fantasy-msx"` を `../../engine/<commit>.js` への import に置き換えてビルドする（`publish/build.ts`）。プレイヤーも目録の `engine` を見て同じファイルを動的に読む。**プレイヤーがエンジンを静的に import してはいけない**。二つ目のエンジンが混ざる。
- だからエンジンを更新しても、過去の作品はビルドし直さずに動く。新しいコミットの `engine/*.js` が一つ増えるだけ。
- ギャラリーは目録だけを読み、作品は選ばれたときに iframe の中で動的に読む。
- 殻を写したあと、殻が持たなくなったファイル（ビルドし直して名前が変わった `assets/` の古い版）は消す。作品とエンジンは殻の外で増えるので触らない。

組み立てた `var/site/` は、そのまま Cloudflare Workers の静的アセットとして `fanm.oyabanare.com` へ送る（`publish/publisher.ts` が `wrangler deploy --assets` を呼ぶ）。一度出したファイルは中身も名前も変わらないので、送られるのは増えた分だけ。設定と初回の手順は [deploy.md](deploy.md)。

## 開発

```bash
git submodule update --init         # engine/fantasy-msx（WebMSX は不要）
npm install
npm run typecheck                   # fanM とエンジンのソースを合わせて型検査
npm run check:templates             # 全テンプレートをヘッドレスで動かし var/check/<型>/ に撮影
npm run gallery:dev                 # play.html?work=<id> で手元の作品やテンプレートを再生
npm run make                        # AIで一作品作る（走っている間に叩くと、その様子が見える）
npm start                           # 常駐して作り続ける（本番のコンテナが動かすのもこれ）
npm run status                      # いまどうなっているか（動いていなければ終了コード 1）
npm run publish                     # 採用作から var/site/ を組み立て、Cloudflare へ送る
npm run publish:local               # 組み立てるところまで（送らない）
```

## 現状

| 部分 | できていること | まだないもの |
| --- | --- | --- |
| バッチ | `fanm make`：企画 → 生成 → 検査 → 修正（最大2回）→ 採用/不採用 を一つのジョブとして回す。ジョブ状態と予算台帳を保存し、途中から再開できる。DeepSeek 接続と、APIキーなしで試す偽のAI（`--fake`）。検査は静的検査・型検査・隔離実行・撮影・画面の数値判定。`fanm run`：残予算と実費から頻度を決めて回し続け、頃合いを見て公開し、直らない問題だけ知らせる。`fanm status` と Dockerfile／docker-compose.yaml（[docs/operate.md](operate.md)） | 不採用作の掃除、ブラウザでの確認、Coolify への初回デプロイ |
| ギャラリー | サムネイルの一覧、作品ごとのURL（`#<id>`）、ランダム再生、iframe の中での動的読込。開発時は未ビルドの手元の作品も再生できる | 連続再生、お気に入り |
| つなぎ | `fanm publish` が `<VAR>/site/` に公開物を組み立て、Cloudflare Workers（`fanm.oyabanare.com`）へ送る。作品とエンジンは増えた分だけビルドし、送るのも増えた分だけ。常駐はこれを既定6時間おきに、送っていない作品があるときだけ呼ぶ | 公開頻度の実測に基づく調整 |

## バッチの制作状態（`<VAR>`、既定は `var/`、`FANM_VAR` で変更）

```text
var/
├─ jobs/<id>/            ジョブ。job.json と attempt-N/（AIの応答、work.ts、meta.json、検査結果、撮影）
├─ works/<id>/public/    採用作のうちギャラリーに出すもの（work.ts, meta.json, thumbnail.png）
├─ works/<id>/private/   出さないもの（企画、検査結果、AI 呼出しの記録）
├─ ledger/YYYY-MM.json   予算台帳（予約と精算）
├─ site/                 公開物（fanm publish が組み立てる）
├─ run.log / run.lock    制作のログ（8MBで run.log.1 へ）と、二重起動を防ぐ鍵
├─ run.json              常駐の覚え書き（最後の制作・公開、生きている目印、人を呼んだ用件）
├─ check/                fanm check の作業場所
└─ fake/                 --fake のときは全部こちら
```
