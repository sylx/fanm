// 公開先への送り出し。<VAR>/site/ の中身を Cloudflare Workers の静的アセットとして上げる。
//
// Workers Static Assets を選んだ。作品もエンジンも、一度ビルドしたら中身も名前も
// 変わらない。wrangler はファイルの中身のハッシュで照合して、すでに向こうにある
// ものは上げ直さないので、作品が増えても通信は増えた分だけで済む。R2 + Worker と
// 違って、前に置く Worker を書かなくてよく、無料枠のまま動く。
//
// 送り先（Worker 名と公開ドメイン）は wrangler.jsonc に、認証情報は環境変数に置く。
// 公開物の置き場所だけはここから --assets で渡す。<VAR> は本番では永続ボリュームに
// 移るので、wrangler.jsonc に書いた相対パスでは届かないため。
//
// 差し替えは一度に切り替わる（新しい版が丸ごと出る）ので、途中まで上がった状態が
// 見えることはない。失敗しても <VAR>/site/ は触らないので、作り直さずに送り直せる。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../..");
const WRANGLER = join(ROOT, "node_modules/.bin/wrangler");

export interface Publisher {
    readonly name: string;
    /** 組み立て済みの公開物を送る。送り終えるまで、今出ているサイトは壊さない。 */
    publish(siteDir: string): Promise<void>;
}

/** 送れなかった。fatal なら人が直すまで再試行しても無駄（認証切れなど）。 */
export class PublishError extends Error {
    constructor(message: string, readonly fatal = false) {
        super(message);
        this.name = "PublishError";
    }
}

export interface CloudflareOptions {
    /** wrangler の設定ファイル。Worker 名と公開ドメインはそこに書いてある。 */
    readonly wranglerConfig: string;
    readonly apiTokenEnv: string;
    readonly accountIdEnv: string;
    /** wrangler の出しているものを流す先。 */
    readonly log?: (text: string) => void;
}

export class CloudflarePublisher implements Publisher {
    readonly name = "Cloudflare Workers";

    constructor(private readonly options: CloudflareOptions) {}

    async publish(siteDir: string): Promise<void> {
        const config = resolve(ROOT, this.options.wranglerConfig);
        if (!existsSync(config)) throw new PublishError(`wrangler の設定がない: ${config}`, true);
        if (!existsSync(join(siteDir, "index.html"))) throw new PublishError(`公開物が組み立てられていない: ${siteDir}`);
        if (!existsSync(WRANGLER)) throw new PublishError("wrangler が入っていない（npm install）", true);

        const token = process.env[this.options.apiTokenEnv];
        const account = process.env[this.options.accountIdEnv];
        if (!token) throw new PublishError(`環境変数 ${this.options.apiTokenEnv} に Cloudflare の APIトークンがない`, true);
        if (!account) throw new PublishError(`環境変数 ${this.options.accountIdEnv} に Cloudflare のアカウントIDがない`, true);

        const args = ["deploy", "--config", config, "--assets", resolve(siteDir)];
        const { code, output } = await this.run(args, {
            CLOUDFLARE_API_TOKEN: token,
            CLOUDFLARE_ACCOUNT_ID: account,
            // 対話に落ちないように。鍵が無効なときは尋ねずに失敗してほしい。
            CI: "1",
            WRANGLER_SEND_METRICS: "false"
        });
        if (code !== 0) {
            // 認証まわりは人が直すまで直らない。それ以外（通信、向こうの不調）は後でもう一度送る。
            const fatal = /authentication|Unauthorized|10000|API token|not authorized/i.test(output);
            throw new PublishError(`wrangler deploy が失敗した（終了コード ${code}）\n${tail(output)}`, fatal);
        }
    }

    private run(args: string[], env: Record<string, string>): Promise<{ code: number; output: string }> {
        return new Promise((done, fail) => {
            const child = spawn(WRANGLER, args, { cwd: ROOT, env: { ...process.env, ...env } });
            let output = "";
            const collect = (chunk: Buffer) => {
                const text = chunk.toString("utf8");
                output += text;
                this.options.log?.(text);
            };
            child.stdout.on("data", collect);
            child.stderr.on("data", collect);
            child.on("error", e => fail(new PublishError(`wrangler を起動できない: ${e.message}`, true)));
            child.on("close", code => done({ code: code ?? 1, output }));
        });
    }
}

/** 失敗したときに残す分。全部は長いので終わりの方だけ。 */
function tail(output: string, lines = 20): string {
    return output.trimEnd().split("\n").slice(-lines).join("\n");
}
