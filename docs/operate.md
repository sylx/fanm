# 常駐運転（chevron / Coolify）

バッチ処理を止めずに動かし続けるための部分。`fanm run` が制作の輪を回し、`fanm status` がその様子を見せる。本番は chevron の Coolify に、この輪を回すコンテナを一つ置く。

```text
fanm run（常駐）
  30秒ごとに目を覚ます
    ├─ 「いま作れ」と頼まれていないか？（<VAR>/now）
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

公開は採用作が出来たその場で行う。送っていない採用作があるときだけ組み立てて送るので、作品が増えない限り通信は起きない。送れなかったら30分おいて送り直す。

## 次を待たずに作らせる

間隔は残予算から決まるので、ふつうは数時間おきになる。それを待てないときは `makenow`。一作品つくって、出来たその場で公開する（知らせもそこで飛ぶ）。

```bash
npm run makenow                 # 手元で。つくって Cloudflare まで
npm run makenow -- --local      # 送らずに var/site へ組み立てるだけ
npm run makenow -- --provider claude          # 今回は Claude に頼む
npm run makenow -- --provider claude-opus-5   # モデル名でも指せる
docker exec -it <container> node_modules/.bin/tsx packages/batch/src/cli.ts makenow
```

`--provider` は今回だけ相手を指す（[札束](#頼む相手を変える混ぜる)からふだんどおり引かせない）。事業者の名前で指すと、その事業者の札が複数あればその中から引く。札束にいない相手を指すと、頼む前にその場で止まる。常駐に頼むときも指定は一緒に渡る。試したい相手が `share` を絞られていても、これなら待たずに一作品出せる。

常駐が動いているかどうかで、することが変わる。

| 常駐 | `makenow` がすること |
| --- | --- |
| 動いている | `<VAR>/now` に頼み（時刻と、指定したなら相手）を置いて「いま作れ」と頼む。常駐が次に目を覚ましたとき（30秒以内）に受け取り、間隔を飛ばして作って送る。頼んだ側はログを映し、終わったら戻る |
| 動いていない | その場で自分が一作品つくって公開する（`fanm run --once` と同じ） |

頼みを覚え書き（`run.json`）ではなく別のファイルにしてあるのには理由がある。常駐は覚え書きをメモリに持ったまま30秒ごとに書き戻すので、外から `run.json` の「最後に作った時刻」を直しても、上書きされて消える。読むだけのファイルなら、動いている最中でも横から渡せる。

飛ばすのは間隔だけで、予算は飛ばさない。使い切って休んでいるときは、頼みを受け取ったうえで断り、ログに残す（`makenow` は終了コード 1 で戻る）。制作の最中に頼めば、それが終わってから続けてもう一作品つくる。頼みは溜まらず、何度置いても一回分。

頼んで作った分も「最後に制作を始めた時刻」に記録するので、次の制作はそこから数え直す。急かした分だけ、あとの間隔が延びる。

## 作品を取り下げる

公開した作品を後から消すには `remove`。作品を作品庫から外し、公開物を組み立て直して送る。

```bash
scripts/fanm-shell.sh fanm remove 20260922-082137-k6vk          # 本番で。送るところまで
scripts/fanm-shell.sh fanm remove <id> <id>                     # まとめて
npm run remove -- <id> --local                                  # 手元で。送らずに var/site から消すだけ
```

id はギャラリーの作品ページの URL（`/work/<id>/`）か、`<VAR>/works/` の名前。**本番の作品は本番で消す。** 手元で消しても本番の作品庫には残り、次の公開でまた出る。

| 段取り | すること |
| --- | --- |
| 外す | `<VAR>/works/<id>/` を `<VAR>/removed/<id>/` へ丸ごと移す。ログに「取り下げた」と残る |
| 組み立てる | 作品庫に無い作品を `<VAR>/site/works/` から消す。直前の目録も捨てる（一覧を開いたままのタブのために一世代前を残しているが、そこに取り下げた作品の題と説明が載っているため） |
| 送る | `publish` と同じ。送り終えると `/work/<id>/` は 404 になる |

取り下げた作品は、過去作の見比べにも、企画の偏りを避ける材料にも、ペンネームの台帳にも使われなくなる。消しはしないので、戻すなら `<VAR>/removed/<id>/` を `<VAR>/works/` へ移し返して `fanm publish`。

送れなかったとき（終了コード 2）も作品庫からは外れたまま。常駐は「送っていない作品」が無いと公開しないので、自分で `fanm publish` を送り直す。Discord に流れた知らせと、そのサムネイルは消えない。

## 知らせ

知らせ先は環境変数 `FANM_NOTIFY_WEBHOOK`（Discord の webhook URL）。送り先は Discord と決めているので、embed で送る。飛ぶのは二種類だけで、どちらも設定していなければログに残る。

携帯の通知に出るのは embed ではなく `content` なので、そこには一行で読める用件だけを置き、中身は embed に入れる。

**作品が出たとき。** 公開が済むたびに、その回に出た作品を一件ずつ embed にして送る。多いときは新しい4件まで並べ、残りは件数だけ（`content` が「新しい作品が出た（5件）。うち新しい 4 件」になる）。

| embed | どこから | 見え方 |
| --- | --- | --- |
| 題 | `meta.title` | 押すと `<siteUrl>/work/<id>/` が開く |
| 説明 | `meta.description` | |
| 絵 | `<siteUrl>/works/<id>/thumb.png` | 一件だけなら大きく、並ぶときは右上に小さく |
| 長さ・操作 | `meta.durationFrames` / `meta.controls` | 横に並ぶ。操作できない作品に「操作」は出さない |
| 帯の色・時刻 | | 緑（プレイヤーの「CRT」と同じ）と `meta.createdAt` |

サムネイルはURLを書くのではなく embed の絵として渡すので、Discord が取りに行く。公開が済んでから知らせるので、そのときには置かれている。

**人の対応が要るとき。** 日常の失敗では呼ばない。不採用、一時的な通信断、送り直しはログに残して次へ進む。呼ぶのは、放っておいても直らないものだけ。

- AIのAPIの認証切れ・残高切れ（`auth` / `quota`）
- 公開の認証切れ・権限不足
- 想定外の失敗が3回続いたとき

こちらは赤い embed 一つ（題は「人の対応が必要」、中身は何が起きたか、下に用件の名前）、`content` は `⚠️ 人の対応が必要` だけ。同じ用件は6時間に一度しか鳴らさず、`fanm status` にも `人の対応が必要:` として残る。

## 手元で試す

```bash
npm run start:fake -- --once   # 偽のAIで一周だけ。APIキーもお金も要らない
npm run start:fake             # 偽のAIで常駐（Ctrl-C で止まる）
npm run status -- --fake       # 偽のAIの状態を見る
npm start                      # 本物のAIで常駐
npm run status                 # いまどうなっているか
npm run makenow -- --fake      # 偽のAIで「いま作れ」を試す（偽の作品は送らない）
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
| 取り下げた作品 | `<VAR>/removed/<id>/` |
| 公開物 | `<VAR>/site/` |
| 常駐の覚え書き（最後の制作・公開、生きている目印、人を呼んだ用件） | `<VAR>/run.json` |
| 二重起動を防ぐ鍵 | `<VAR>/run.lock` |
| 「いま作れ」の頼み（受け取ると消える） | `<VAR>/now` |
| ログ | `<VAR>/run.log` |
| 設定（任意） | `FANM_CONFIG`（本番では `/data/fanm.json`） |

設定を永続ボリュームに置けるので、予算や頻度を変えるのにイメージを作り直さなくてよい。置かなければ既定値で動く（`packages/batch/src/config.ts` の `DEFAULTS`）。

**常駐は設定を読み直す。** 30秒ごとに目を覚ますたびにファイルを見て、中身が変わっていれば読み直す。制作に入るのはそのあとなので、作りはじめるときの設定は必ず新しい。書き替えたら入れ替えも再起動も要らない。

```
[…] 設定を読み直した（budget、providers）。札束は deepseek-v4-pro / claude-opus-5×0
```

- 書きかけを掴んでも止まらない。読めない JSON は捨てて、前の設定のまま続ける（`設定を読めない。前のまま続ける`）。直せば次の30秒で入る。同じ中身は二度読まないので、壊れたまま置いても言い続けない。
- 鍵の無い相手や単価表に無いモデルを足したときも、前の設定のまま続ける（`新しい設定の札束を使えない`）。動いているものを書き間違いで止めない。
- **送り先（`publish` の Cloudflare 周り）だけは入れ替えが要る。** 送り口は起動時に作るので、あとから変えても効かない。知らせに貼るリンクは追う。

## 頼む相手を変える・混ぜる

`fanm.json` の `providers` が**札束**で、ジョブのたびにここから一人引く。型（`plan/forms.ts`）や縛り（`plan/variations.ts`）と同じ引き方で、直近の作品で少ない相手が先に当たる。引くのはジョブの種なので、途中で落ちて再開しても相手は変わらない。誰が書いたかは作品の `meta.json`（`model`）に残り、ギャラリーのカードにも出る。

APIキーを入れる環境変数は事業者ごとに決まっていて、設定には書かない。

| 事業者 | `name` | `model` の例 | APIキーの環境変数 |
| --- | --- | --- | --- |
| DeepSeek | `deepseek` | `deepseek-v4-pro`、`deepseek-flash` | `DEEPSEEK_API_KEY` |
| Claude | `claude` | `claude-opus-5`、`claude-opus-4-8`、`claude-sonnet-5` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | `gpt-6-astra`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5` | `OPENAI_API_KEY` |

一人だけに頼むなら、札を一枚だけ書く。

```json
{ "providers": [{ "name": "claude", "model": "claude-opus-5" }] }
```

混ぜるなら、札を並べて `share`（引かれやすさ）を書く。下は「六作に一作を Claude に頼む」。

```json
{
  "providers": [
    { "name": "deepseek", "model": "deepseek-v4-pro", "share": 5 },
    { "name": "claude", "model": "claude-opus-5", "share": 1, "perWorkUsd": 2.5 }
  ]
}
```

- `share` を `0` にすると引かれない。札を消さずに休ませられる。
- `perWorkUsd` はその相手に頼むときの一作品の上限。省くと `budget.perWorkUsd`。
- `reuse` はその相手のときに過去の作り手を呼び戻す割合。省くと `persona.reuse`（下の「作り手の性格とペンネーム」）。
- `apiKeyEnv` と `baseUrl` は書かなくてよい（書けば上書きできる）。単価は `packages/batch/src/providers/` の各ファイルが持っていて、載っていないモデル名は起動のときに弾かれる。鍵も札束ぜんぶぶん、始める前に確かめる。
- 札が一枚だけの古い書き方（`"provider": { … }`）も読む。

**予算は札束と一緒に動かす。** 呼出しの前に最大想定費用を予約するので、一回ぶんの予約が上限を超えると、一度も呼ばないまま不採用になる。手元で測った生成一回の予約額:

| モデル | 予約額 |
| --- | --- |
| `deepseek-v4-pro` | $0.12 |
| `claude-sonnet-5` | $0.25 |
| `claude-opus-5` | $0.63 |

`claude-opus-5` を札束に入れるなら、その札に `perWorkUsd` を $2.5 ほど付ける（企画1回・生成1回・修正2回まで見た額）。全体の `budget.perWorkUsd` を上げてしまうと、安い相手の暴走まで許すことになる。月額（`budget.monthlyUsd`）は使い切らないように制作の間隔が自動で延びる（実測の一作品あたりの費用から決まる）ので、高い相手を混ぜると作る本数が減る。

実費は予約額より下がる。予約は入力を高めに見積もっていて、Claude では制作ルールとAPI資料（6万字、どの呼出しでも同じ）に入力キャッシュの印を付けているので、二回目からの読み出しは十分の一で数えられる。

### 作り手の性格とペンネーム

相手を引いたあと、作り手の**性格**も引いて企画と生成の頼みに書き込む（`packages/batch/src/persona/persona.ts`）。いまの軸は三つ。

| 軸（id） | 値 |
| --- | --- |
| 緻密↔大雑把（`precision`） | 0〜1 を 0.25 刻み |
| こだわり（`focus`） | `graphics` / `music` / `gameplay` |
| 感性に従う↔理性的（`intuition`） | 0〜1 を 0.25 刻み |

同じモデルで同じ性格の作り手は、同じ**ペンネーム**を名乗る（`persona/pen-name.ts`）。DeepSeek は日本語（豪快太郎）、Claude は英語（GoldenSnail）、OpenAI は外来語と日本の名前（シャープ一郎）。頭の語は緻密なら細い語、大雑把なら太い語から選ぶ。作品の `meta.json` には `model` と並んで `penName` と `traits` が入る。

**過去の作り手を呼び戻す。** 性格を引くだけでは、同じ作り手が出るかは一モデル75人の中の偶然に任される。そこで `fanm.json` の `persona.reuse`（既定 `0.3`）の割合で、引いた相手に採用作のある作り手がいれば、その中から一人を選んで書かせる（ログに「再登場」と出る）。`0` にすると毎回新しく引き、`1` にすると作り手のいるモデルでは必ず顔なじみになる。

```json
{ "persona": { "reuse": 0.3 } }
```

札ごとにも書ける（`providers` の札の `reuse`）。単価の高い相手は引かれる回数そのものが少なく、全体の割合のままだと作り手が毎回違う顔になる。そういう札だけ高くしておく。

```json
{
  "providers": [
    { "name": "deepseek", "model": "deepseek-v4-pro", "share": 6 },
    { "name": "claude", "model": "claude-opus-5", "share": 1, "perWorkUsd": 2.5, "reuse": 0.8 }
  ],
  "persona": { "reuse": 0.3 }
}
```

名前は性格の鍵（モデル＋軸の値）から決まり、別の作り手と名前がぶつかったら散らし直す。一度採用された作り手の名前は作品庫の meta が台帳になるので、単語の表を書き替えても変わらない。

**軸を足すときは `neutral`（その軸が無かったころの振る舞い）を書く。** 鍵は `neutral` の軸を含めないので、新しい軸が `neutral` の作り手は前と同じ名前のまま、それ以外の値を引いた作り手は新しい名前になる。軸と選択肢の id、連続の軸の刻みは変えない（変えると鍵が変わる）。頼みに入れる文はいつ書き替えてもよい。

## コンテナ

```bash
docker build -t fanm-batch .
docker run -d --name fanm -v fanm-var:/data --env-file .env fanm-batch
docker exec fanm node_modules/.bin/tsx packages/batch/src/cli.ts status
docker exec -it fanm node_modules/.bin/tsx packages/batch/src/cli.ts makenow
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
    | `DEEPSEEK_API_KEY` | AIのAPIキー。無いと起動しない（Claude なら `ANTHROPIC_API_KEY`、OpenAI なら `OPENAI_API_KEY`。札束にいる相手のぶんだけ要る） |
    | `CLOUDFLARE_API_TOKEN` | 公開用（[docs/deploy.md](deploy.md)） |
    | `CLOUDFLARE_ACCOUNT_ID` | 同上 |
    | `FANM_NOTIFY_WEBHOOK` | 知らせ先。無くてもよい |

4. **Deploy する。** 永続ボリューム `fanm-var` は compose が宣言しているので、Coolify が作って引き継ぐ。
5. **手元の作品を引き継ぐなら、ここで一度 Stop して「[手元の作品を持っていく](#手元の作品を持っていく)」を済ませる。** 空のまま回すと、最初の公開で今出ている作品が消える。
6. **様子を見る。** ログに `常駐を始める` と `次の制作は …` が出れば回り始めている。数時間後に `fanm.oyabanare.com` に作品が増える。

再デプロイしてもボリュームは残るので、使用額も作品も引き継がれる。

### push したら配り直す

`main` への push で配り直すのは GitHub Actions（[.github/workflows/deploy.yml](../.github/workflows/deploy.yml)）。型検査を通してから、Coolify の manual GitHub webhook を叩く。

GitHub から Coolify の webhook を直接叩かせることもできるが、それだと型の壊れた版も配られる。tsx は型を見ずに動かすので、壊れていてもイメージはできてしまう。止められるのはここだけ。

必要な秘密は二つ（Settings → Secrets and variables → Actions）。

| 名前 | 中身 |
| --- | --- |
| `COOLIFY_WEBHOOK_URL` | `http://<chevron>:8000/webhooks/source/github/events/manual` |
| `COOLIFY_WEBHOOK_SECRET` | Coolify のアプリ（fanM Batch）の Webhooks タブにあるもの |

秘密は本文ではなく署名に使う（本文の HMAC-SHA256 を `X-Hub-Signature-256` に載せる）。本文は push イベントを名乗る最小限のもので、Coolify が見るのはリポジトリ名と枝、それと `commits`。`commits` を省くと Coolify は 500 を返す。

コミットの文に `[skip ci]` か `[skip cd]` が入っていれば、Coolify は配り直さない（Actions は成功のまま）。配り直しを自分で始めたいときは Actions の `deploy` を workflow_dispatch で回すか、Coolify の Redeploy を押す。

`docs/` と `README.md` だけの push では配り直さない。配り直すと常駐が入れ替わり、作っている途中なら呼出しが一つ無駄になる。`prompts/` と `templates/` はAIへ渡すものなので、読み物に見えても配る。

秘密を入れる前に置いたときや、ワークフローを足した当の push では走らないことがある（実際に走らなかった）。最初の一回は手動で回す。

```bash
gh auth switch --user sylx          # 秘密の登録や実行し直しには、持ち主の権限が要る
gh workflow run deploy.yml --ref main
gh run watch
```

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

## 本番から手元へ引き取る

本番が作った作品と使用額を手元へ持ってくるのは `scripts/fanm-pull.sh`。向きは一方通行で、本番へ書き戻すことはしない（持っていくのは上の手順のまま、人の手で行う）。

```bash
scripts/fanm-pull.sh            # 差分を見せて、承諾してから写す
scripts/fanm-pull.sh -n         # 見るだけ
scripts/fanm-pull.sh -v         # 差分を省略せず全部出す
scripts/fanm-pull.sh -y works   # works だけを黙って写す
```

引き取るのは `works` `ledger` `site` の三つだけ。`jobs`（19MB）も `run.log` も `run.json` も触らない。`run.json` を持ってくると「どこまで公開したか」の覚え書きまで本番のものになり、手元の公開が噛み合わなくなる。

**完全ミラーなので、本番に無いものは手元から消える。** 手元でしか作っていない作品があるなら、先に `-n` で確かめる。差分は「手元から消す / 増える / 直る」の件数で先に出る。

| 段取り | すること |
| --- | --- |
| ボリュームを探す | `docker volume ls` で末尾が `fanm-var` のもの。Coolify が頭に一意の文字列を足すので、名前は再デプロイで変わりうる |
| コンテナを探す | そのボリュームを繋いでいるもの。止まっていてもよい（`docker cp` は止まったコンテナからも読める） |
| 降ろす | `docker cp` の tar を ssh 越しに受け、いったん手元の仮置き場へ広げる |
| 見比べる | `rsync --delete --dry-run` で差分を出し、承諾を取る |
| 写す | 仮置き場から `var/` へ。途中で失敗しても `var/` は触られていない |

常駐が動いたままでも読めるが、台帳を書いている最中に当たると、その回だけ古い額が届くことがある（次に引き取れば揃う）。

接続先は既定で `chevron`（`~/.ssh/config` の Host 名）。別のところに置いたなら `--remote`、ボリュームやコンテナを選びたいなら `--volume` / `--container`。環境変数 `FANM_REMOTE` `FANM_VOLUME` `FANM_CONTAINER` でも同じ。

## 手元から本番へ設定を送る

運ぶのが設定ひとつだけなら `scripts/conf-push.sh`。`config/fanm.json` を本番の `/data/fanm.json` に置く。作品や台帳は本番のものが正しいので、この道具は設定しか送らない。

```bash
scripts/conf-push.sh            # 差分を見せて、承諾してから送る
scripts/conf-push.sh -n         # 見るだけ
scripts/conf-push.sh -y         # 確認を求めずに送る
scripts/conf-push.sh 別の.json  # 送るファイルを指定する
```

| 段取り | すること |
| --- | --- |
| 確かめる | 送る設定を fanm 自身に読ませる。壊れた JSON、空の札束、単価表に無いモデルはここで止まる。読めたら札束・予算・頻度を並べて見せる |
| 見比べる | 本番にいま置かれているものとの差分を出し、承諾を取る（初回は置かれていないので、まるごと） |
| 送る | 一つ前を `/data/fanm.json.bak` に残し、`.tmp` へ書いてから一息で置き換える。読み返して中身が同じか確かめる |
| 見届ける | 常駐が読み直すまで待ち、ログの行を出す（最大45秒、`--no-wait` で待たない） |

送ったあとに入れ替えは要らない。常駐が30秒以内に読み直す。ログに `設定を読み直した（…）` が出れば入っている。`設定を読めない` や `札束を使えない` が出たら本番は前の設定のまま続けているので、直してもう一度送る（スクリプトも終了コード 1 で戻る）。何も出ないときは、設定を読み直さない古い版が動いている（その場合だけ再デプロイが要る）。

**送り先（`publish` の Cloudflare 周り）を変えたときは再デプロイが要る。** 送り口は起動時に作るので、設定だけ送っても効かない。

接続先とボリュームの選び方は引き取りと同じ（`--remote` / `--volume` / `--container`、`FANM_REMOTE` ほか）。

## 困ったとき

| 見えているもの | 意味 | すること |
| --- | --- | --- |
| `常駐: 動いていない` | 落ちたか、まだ起動していない | Coolify のログを見る。`restart: unless-stopped` なので、落ちたなら自動で戻っている |
| `いま: 休んでいる` | 予算切れ。翌月まで待つ | 増やすなら `/data/fanm.json` の `budget.monthlyUsd` |
| 次の制作まで待てない | 間隔は残予算から決まっている | `makenow` で横から頼む（[次を待たずに作らせる](#次を待たずに作らせる)） |
| `人の対応が必要: AIのAPIを使えない` | 鍵切れ・残高切れ | 環境変数を直して再デプロイ |
| `人の対応が必要: 公開できない` | Cloudflare の鍵か権限 | [docs/deploy.md](deploy.md) の手順で作り直す |
| `目印は…、古い` | 固まっている | コンテナを再起動する。ジョブは続きから進む |
| `想定外の失敗` が続く | ログに残る | `<VAR>/run.log` の該当箇所を見る。間を置いて再試行は続いている |

## 本番のコンテナに入る

中をのぞくだけなら `scripts/fanm-shell.sh`。chevron に ssh し、動いているバッチのコンテナで bash を開く。コンテナは他の道具と同じく、`fanm-var` のボリュームを繋いだものを探すので、再デプロイで名前が変わっても気にしなくてよい。

```bash
scripts/fanm-shell.sh                       # 中で bash を開く（node で入る）
scripts/fanm-shell.sh fanm status           # 一つだけ動かして戻る
scripts/fanm-shell.sh tail -f /data/run.log
scripts/fanm-shell.sh --root                # root で入る
```

中では `fanm` が関数として使える（イメージに `fanm` のリンクは無い）。`--remote` `--volume` `--container` と環境変数は他の道具と同じ。
