# 常駐運転（chevron / Coolify）

バッチ処理を止めずに動かし続けるための部分。`fanm run` が制作の輪を回し、`fanm status` がその様子を見せる。本番は chevron の Coolify に、この輪を回すコンテナを一つ置く。

```text
fanm run（常駐）
  30秒ごとに目を覚ます
    ├─ いま作ってよいか？（残予算と残日数から頻度を決める）
    │    └─ よければ一作品つくる（企画 → 生成 → 検査 → 修正 → 採用/不採用）
    └─ 送るものが溜まっていて、前の公開から一定時間たったか？
         └─ <VAR>/site/ を組み立てて Cloudflare へ送る
```

## 頻度の決め方

一日に何回作るかは設定しない。決めるのは**上限**だけで、実際の頻度は残予算から毎回計算する。

```text
一日あたりの回数 = min(設定の上限, 今月の残り $ ÷ (一作品あたりの実費 × 残り日数))
```

一作品あたりの実費は、直近8ジョブの台帳（修正も不採用も込み）の平均。安く済んでいれば自然と回数が増え、高くつけば減る。実測がまだ無い最初だけ、作品予算の 1/4 を見込む。

| 状況 | 次にすること |
| --- | --- |
| 月間予算を使い切った | 翌月の頭まで休む。ジョブは残り、続きから再開する |
| 残予算が薄く、間隔が月をまたぐ | 翌月の頭まで休む |
| 長く止まっていた | 再開後に走るのは一回分だけ。溜まった予定は取り戻さない |
| 中断したジョブがある | 間隔を待たずに、起動直後に続きから片づける |

公開は制作より粗い間隔で行う（既定6時間、`publish.everyHours`）。送っていない採用作があるときだけ組み立てて送るので、作品が増えない限り通信は起きない。

## 知らせ

知らせ先は環境変数 `FANM_NOTIFY_WEBHOOK`（Discord や Slack の webhook URL）。飛ぶのは二種類だけで、どちらも設定していなければログに残る。

**作品が出たとき。** 公開が済むたびに、その回に出た作品の題と説明、ギャラリーのリンク、サムネイルのURLを送る。受け取った側で絵が見える。多いときは新しい4件まで並べ、残りは件数だけ。

```text
fanM: 新しい作品が出た（1件）

STONE HOLLOW — 草と水の地を歩き、洞窟の主に出会っては戦う。放っておくと…
https://fanm.oyabanare.com/#20260920-090457-6man
https://fanm.oyabanare.com/works/20260920-090457-6man/thumb.png
```

**人の対応が要るとき。** 日常の失敗では呼ばない。不採用、一時的な通信断、送り直しはログに残して次へ進む。呼ぶのは、放っておいても直らないものだけ。

- AIのAPIの認証切れ・残高切れ（`auth` / `quota`）
- 公開の認証切れ・権限不足
- 想定外の失敗が3回続いたとき

こちらは同じ用件を6時間に一度しか鳴らさず、`fanm status` にも `人の対応が必要:` として残る。

## 手元で試す

```bash
npm run start:fake -- --once   # 偽のAIで一周だけ。APIキーもお金も要らない
npm run start:fake             # 偽のAIで常駐（Ctrl-C で止まる）
npm run status -- --fake       # 偽のAIの状態を見る
npm start                      # 本物のAIで常駐
npm run status                 # いまどうなっているか
```

`fanm status` は、常駐が動いていて・目印が新しく・人を呼んでいなければ終了コード 0、そうでなければ 1。コンテナの健康診断もこれを使っている。

```text
常駐: 動いている（pid 18、3.2時間前から）
  いま: 次の制作を待っている（目印は12秒前）
  次の制作: 2026-09-20T14:10:19.240Z（あと2.8時間）
  今月: $1.1850 / $12（一作品あたり $0.0243）
  作品: 9 件（未公開 1 件）、最後の公開は5.1時間前
  途中のジョブ: なし
```

制作の様子（AIの思考も）を覗くなら `tail -f <VAR>/run.log`。8MBを超えたら `run.log.1` へ送られ、一つ前だけ残る。

## 置き場所

状態はすべて `FANM_VAR`（本番では永続ボリューム `/data`）の下にある。イメージには入らない。

| もの | 場所 |
| --- | --- |
| ジョブ | `<VAR>/jobs/<id>/` |
| 予算台帳 | `<VAR>/ledger/YYYY-MM.json` |
| 作品庫 | `<VAR>/works/<id>/` |
| 公開物 | `<VAR>/site/` |
| 常駐の覚え書き（最後の制作・公開、生きている目印、人を呼んだ用件） | `<VAR>/run.json` |
| 二重起動を防ぐ鍵 | `<VAR>/run.lock` |
| ログ | `<VAR>/run.log` |
| 設定（任意） | `FANM_CONFIG`（本番では `/data/fanm.json`） |

設定を永続ボリュームに置けるので、予算や頻度を変えるのにイメージを作り直さなくてよい。置かなければ既定値で動く（`packages/batch/src/config.ts` の `DEFAULTS`）。

## コンテナ

```bash
docker build -t fanm-batch .
docker run -d --name fanm -v fanm-var:/data --env-file .env fanm-batch
docker exec fanm node_modules/.bin/tsx packages/batch/src/cli.ts status
```

イメージには、固定したエンジン（`engine/COMMIT` にそのコミットを控える）、ギャラリーの殻、依存が入る。`.git` は最後の段に残さない。

`docker stop` で止めると、待っている最中ならその場で、制作の最中でもジョブと台帳が書かれた時点まで残って終わる。次に起動すると、予約のまま残った呼出しを精算してから続きを進める。

## Coolify に置く（初回）

fanM も fantasy-msx も公開リポジトリなので、Coolify の **Public Repository** から直接デプロイできる。GitHub App も deploy key も要らない。

1. **リポジトリを push する。** Coolify はここから clone してビルドする。
2. **Coolify → New Resource → Public Repository。**

    | 項目 | 値 |
    | --- | --- |
    | Repository URL | `https://github.com/sylx/fanm` |
    | Branch | `main` |
    | Build Pack | Docker Compose |
    | Base Directory | `/` |
    | Docker Compose Location | `/docker-compose.yaml` |

    公開サイトはギャラリー側（Cloudflare）なので、ドメインもポートも割り当てない。

3. **環境変数を入れる。** compose が `${...}` で参照しているものが、そのまま Coolify の入力欄に出る。

    | 名前 | 中身 |
    | --- | --- |
    | `DEEPSEEK_API_KEY` | AIのAPIキー。無いと起動しない |
    | `CLOUDFLARE_API_TOKEN` | 公開用（[docs/deploy.md](deploy.md)） |
    | `CLOUDFLARE_ACCOUNT_ID` | 同上 |
    | `FANM_NOTIFY_WEBHOOK` | 知らせ先。無くてもよい |

4. **Deploy する。** 永続ボリューム `fanm-var` は compose が宣言しているので、Coolify が作って引き継ぐ。
5. **手元の作品を引き継ぐなら、ここで一度 Stop して「[手元の作品を持っていく](#手元の作品を持っていく)」を済ませる。** 空のまま回すと、最初の公開で今出ている作品が消える。
6. **様子を見る。** ログに `常駐を始める` と `次の制作は …` が出れば回り始めている。数時間後に `fanm.oyabanare.com` に作品が増える。

Public Repository は push で自動デプロイしない（それが要るなら GitHub App 経由に変える）。コードを直したら Coolify の Redeploy を押す。再デプロイしてもボリュームは残るので、使用額も作品も引き継がれる。

## 手元の作品を持っていく

**これを先にやる。** 空のまま常駐を始めると、最初の公開で今出ている作品が消える。公開物は版ごと差し替わるので、作品庫が空なら「作品が0件のギャラリー」がそのまま出てしまう。

持っていくのは3つ。合わせて 1MB 足らず。

| 中身 | なぜ |
| --- | --- |
| `var/works/` | 採用作そのもの。企画の記録も入っているので、次の企画が過去作に寄らない |
| `var/ledger/` | 今月の使用額。忘れると、その月だけ予算を二重に使える |
| `var/site/` | 組み立て済みの公開物。既存の作品とエンジンを作り直させないため（下記） |

`var/jobs/`（試行と撮影、19MB）は持っていかない。途中のジョブがあるときだけ、そのジョブのディレクトリを足せばよい。

```bash
# 1. 手元で固める
tar -C var -czf fanm-archive.tgz works ledger site

# 2. chevron へ送る
scp fanm-archive.tgz chevron:/tmp/

# 3. Coolify でデプロイし、いったん Stop する
#    （常駐が台帳を書いている最中に上書きしないため）

# 4. ボリュームへ広げる
ssh chevron
docker volume ls | grep fanm     # Coolify が作ったボリューム名を確かめる
docker run --rm -v <volume>:/data -v /tmp:/in:ro alpine \
    sh -c 'tar -C /data -xzf /in/fanm-archive.tgz && chown -R 1000:1000 /data'

# 5. Coolify で Start
```

`chown` は、コンテナが `node`（uid 1000）で動くため。

入ったかどうかは `fanm status` の「作品: N 件」と `fanm budget` で分かる。最初の公開では、まだ送っていない作品だけが増えて出る（同じ中身のファイルは wrangler が上げ直さない）。

`run.json`（どこまで公開したかの覚え書き）は持っていかない。空のまま始めると、起動後の最初の周で一度だけ公開が走る。

### なぜ `var/site/` も持っていくのか

エンジンの束（`engine/<commit>.js`）は、作品が記録しているコミットの名前で置かれるが、束ねる中身は**そのときの submodule の中身**から作られる。つまり、組み立て済みの公開物を持っていかないと、古いコミットの名前のまま今の版のエンジンが置き直される。名前は「中身が変わらないもの」として長く持たせる指示を出しているので、これは避けたい。

`var/site/` ごと持っていけば、すでにあるエンジンと作品はそのまま使われ、新しい分だけが組み立てられる。

### submodule と固定したエンジン

fantasy-msx は submodule なので、Coolify の clone が展開するとは限らない。イメージのビルドは、どの取り込まれ方でも同じコミットになるようにしてある。

| 手元にあるもの | すること |
| --- | --- |
| submodule の中身がある | それをそのまま使う |
| 空（展開されなかった） | `engine/COMMIT` のコミットを公開リポジトリから取ってくる |
| `.git` もある | submodule の指し先と `engine/COMMIT` が食い違っていればビルドを止める |

`engine/COMMIT` はリポジトリに入っている。エンジンを更新したら `npm run engine:pin` で控え直す（忘れたままイメージを作ろうとすると、上の突き合わせで止まる）。

## 困ったとき

| 見えているもの | 意味 | すること |
| --- | --- | --- |
| `常駐: 動いていない` | 落ちたか、まだ起動していない | Coolify のログを見る。`restart: unless-stopped` なので、落ちたなら自動で戻っている |
| `いま: 休んでいる` | 予算切れ。翌月まで待つ | 増やすなら `/data/fanm.json` の `budget.monthlyUsd` |
| `人の対応が必要: AIのAPIを使えない` | 鍵切れ・残高切れ | 環境変数を直して再デプロイ |
| `人の対応が必要: 公開できない` | Cloudflare の鍵か権限 | [docs/deploy.md](deploy.md) の手順で作り直す |
| `目印は…、古い` | 固まっている | コンテナを再起動する。ジョブは続きから進む |
| `想定外の失敗` が続く | ログに残る | `<VAR>/run.log` の該当箇所を見る。間を置いて再試行は続いている |
