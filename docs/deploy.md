# 公開（Cloudflare Workers）

ギャラリーは `fanm.oyabanare.com` に出す。`fanm publish` が `<VAR>/site/` を組み立て、その中身を Cloudflare Workers の静的アセットとして送る。`/work/<id>/` は同時に公開する Worker が作品メタデータと共通テンプレートからHTMLを返す。閲覧時にAI APIや制作バッチへ接続せず、バッチが止まっていても閲覧できる。

```text
fanm publish
  ├─ 作品庫から var/site/ を組み立てる（増えた作品とエンジンだけビルド）
  └─ wrangler deploy --config wrangler.jsonc --assets <VAR>/site
       └─ fanm.oyabanare.com
```

## なぜ Workers Static Assets か

作品もエンジンも、一度ビルドしたら中身も名前も変わらない（`works/<id>/work.js`、`engine/<commit>.js`）。wrangler はファイルの中身のハッシュで向こうにあるものと照合し、すでにあるものは上げ直さないので、作品が 100 件になっても毎回の通信は増えた分だけで済む。画像・JS・一覧JSONは直接静的配信し、Workerを先に実行する経路は `/work/*` に限定する。作品HTMLの生成だけがWorkersの実行枠を使う。

差し替えは版ごと一度に切り替わる。途中まで上がった状態が見えることはなく、送るのに失敗しても今出ているサイトはそのまま残る。

## 設定の置き場所

| もの | どこ |
| --- | --- |
| Worker 名、公開ドメイン | `wrangler.jsonc` |
| 公開物の置き場所（`--assets`） | `publish/publisher.ts` が毎回渡す。`<VAR>` は本番では永続ボリュームに移るので設定ファイルに書けない |
| 送り先を使うかどうか | `config/fanm.json` の `publish.target`（`"cloudflare"` / `"none"`） |
| 認証情報 | 環境変数 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` |

認証情報はリポジトリにもイメージにも入れない。手元では `.env`、本番では Coolify の環境変数で渡す。

配り方の指示は `_headers` として `fanm publish` が毎回書く。名前に中身が織り込まれているもの（`engine/`、`assets/`、`fonts/`、`works/catalog/`）だけをずっと持たせ、目録と作品は既定のまま毎回確かめさせる。

## Cloudflare 側でやること（初回だけ）

`oyabanare.com` はすでに Cloudflare のゾーンにある。触るのは `fanm` の1レコードだけで、既存のレコードには手を出さない。

1. **Workers を使える状態にする。** ダッシュボードの Workers & Pages を一度開く。そのアカウントで Worker を作るのが初めてなら、ここで `*.workers.dev` のサブドメインを決めるよう促される。決めておかないと最初の deploy が止まる（`fanm.oyabanare.com` だけで公開するので、この名前自体は使わない）。
2. **アカウントIDを控える。** Workers & Pages の右側、または `npx wrangler whoami`。
3. **APIトークンを作る。** My Profile → API Tokens → Create Token → テンプレート「Edit Cloudflare Workers」。対象を、このアカウントと `oyabanare.com` ゾーンだけに絞る。必要な権限は Account: Workers Scripts（編集）、Zone: Workers Routes（編集）、DNS（編集）、Zone（読取）。
4. **環境変数に入れる。**

    ```bash
    # 手元（.env、git には入らない）
    CLOUDFLARE_API_TOKEN=...
    CLOUDFLARE_ACCOUNT_ID=...
    ```

    本番は Coolify のバッチ処理コンテナに同じ二つを設定する。

5. **一度送る。**

    ```bash
    npm run publish
    ```

    Worker `fanm` が作られ、`fanm.oyabanare.com` のDNSレコードと経路が自動で足される。証明書が出るまで数分かかることがある。

以降は人の操作は要らない。`fanm publish` を繰り返すだけで、増えた作品が同じドメインに出る。

## 確かめる

```bash
npm run publish:local   # 組み立てるところまで。どこへも送らない
npx wrangler deploy --config wrangler.jsonc --assets "$PWD/var/site" --dry-run
npx wrangler versions list --name fanm    # 出ている版
```

`--fake` で作った作品は送らない（`<VAR>/fake/` の作品庫は公開物に混ざらない）。

## 失敗したとき

`fanm publish` は、送れなくても `<VAR>/site/` を壊さない。作品を作り直す必要はなく、`fanm publish` をもう一度叩けばよい。

| ログ | 意味 |
| --- | --- |
| `送れなかった（あとでもう一度）` | 通信や向こうの不調。次の公開で送り直す |
| `人の対応が必要` | トークンの期限切れ・権限不足・設定の誤り。直すまで何度送っても同じ |

## 作品HTMLと開発プレビュー

`packages/gallery/worker/index.ts` が `/work/<id>/` を処理し、ASSETS binding から `works/<id>/meta.json` と `/` の共通HTMLを読む。タイトル・説明・canonical・OGP・初期作品データを埋め込み、存在しない作品には404を返す。共通HTMLはReactの一覧・操作UIを起動する。作品の実行は `/play.html?work=<id>` のiframe内で行う。

HTMLは Cache API に1時間保存する。キーに Worker Version Metadata のIDを含め、再デプロイやロールバックで別の公開版のHTMLを混ぜない。ブラウザには毎回再検証を要求する。Workers Cacheの全体設定は有効にしない。

`npm run gallery:dev` だけで `http://localhost:5173/` と `/work/<id>/` をプレビューできる。Viteのミドルウェアが本番と同じWeb標準のWorkerハンドラを実行し、ASSETSの代わりに `var/works/*/public/` とVite変換済みHTMLを渡す。公開物の事前生成やCloudflareの認証は不要。Reactと作品コードはViteで変換され、作品庫の変更も再読込される。`/play.html?work=ambient` などのテンプレート再生も従来どおり使える。

Cloudflare固有のキャッシュ・ルーティングも含む最終確認には、次を使う（外部には公開しない）。

```bash
npm run publish:local
npx wrangler dev --assets var/site --port 8787 --local
```

テストは `npm run gallery:test`。ブラウザテストは初回に `npx playwright install chromium` を実行し、`npm run gallery:test:browser` で実行する。ブラウザテストには `var/works` に最低一つの作品が必要。`FANM_GALLERY_URL=http://localhost:8787 npm run gallery:test:browser` で本番ビルドを同じテストに通せる。
