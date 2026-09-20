# 公開（Cloudflare Workers）

ギャラリーは `fanm.oyabanare.com` に出す。`fanm publish` が `<VAR>/site/` を組み立て、その中身をそのまま Cloudflare Workers の静的アセットとして送る。動くコードを持たない Worker なので、閲覧側でAPIは呼ばれず、バッチが止まっていてもサイトは出たままになる。

```text
fanm publish
  ├─ 作品庫から var/site/ を組み立てる（増えた作品とエンジンだけビルド）
  └─ wrangler deploy --config wrangler.jsonc --assets <VAR>/site
       └─ fanm.oyabanare.com
```

## なぜ Workers Static Assets か

作品もエンジンも、一度ビルドしたら中身も名前も変わらない（`works/<id>/work.js`、`engine/<commit>.js`）。wrangler はファイルの中身のハッシュで向こうにあるものと照合し、すでにあるものは上げ直さないので、作品が 100 件になっても毎回の通信は増えた分だけで済む。R2 に置いて Worker から読む方式と違い、前に置く Worker を書かなくてよく、静的アセットの配信は無料枠の請求対象外になる。

差し替えは版ごと一度に切り替わる。途中まで上がった状態が見えることはなく、送るのに失敗しても今出ているサイトはそのまま残る。

## 設定の置き場所

| もの | どこ |
| --- | --- |
| Worker 名、公開ドメイン | `wrangler.jsonc` |
| 公開物の置き場所（`--assets`） | `publish/publisher.ts` が毎回渡す。`<VAR>` は本番では永続ボリュームに移るので設定ファイルに書けない |
| 送り先を使うかどうか | `config/fanm.json` の `publish.target`（`"cloudflare"` / `"none"`） |
| 認証情報 | 環境変数 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` |

認証情報はリポジトリにもイメージにも入れない。手元では `.env`、本番では Coolify の環境変数で渡す。

配り方の指示は `_headers` として `fanm publish` が毎回書く。名前に中身が織り込まれているもの（`engine/`、`assets/`、`fonts/`）だけをずっと持たせ、目録と作品は既定のまま毎回確かめさせる。

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
