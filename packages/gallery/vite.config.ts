import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { galleryDev } from "./server/dev.js";

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** SNS のクローラーが JS を動かさなくても読めるよう、両ページの HTML に埋め込む。 */
function socialPreview(): Plugin {
    const origin = "https://fanm.oyabanare.com";
    const source = readFileSync(root("packages/gallery/assets/og-image.png"));
    // assets/ は immutable で配るので、画像の更新時には URL も変える。
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
    const fileName = `assets/og-image-${hash}.png`;
    const title = "fanM - AIが無限にMSX2風のデモを作り続けるサイト";
    const description = "AIがつくり続けるMSX2風のデモ。新しい作品をブラウザで楽しめます。";
    const alt = "fanMのロゴとマスコット。AIがつくり続けるMSX2風のデモ。";
    let building = false;

    return {
        name: "fanm-social-preview",
        configResolved(config) {
            building = config.command === "build";
        },
        buildStart() {
            if (building) this.emitFile({ type: "asset", fileName, source });
        },
        transformIndexHtml(_html, ctx) {
            const image = ctx.server ? "/assets/og-image.png" : `${origin}/${fileName}`;
            const properties = {
                "og:type": "website",
                "og:site_name": "fanM",
                "og:locale": "ja_JP",
                "og:title": title,
                "og:description": description,
                "og:image": image,
                "og:image:type": "image/png",
                "og:image:width": "1200",
                "og:image:height": "630",
                "og:image:alt": alt
            };
            const names = {
                description,
                "twitter:card": "summary_large_image",
                "twitter:title": title,
                "twitter:description": description,
                "twitter:image": image,
                "twitter:image:alt": alt
            };
            return [
                ...Object.entries(properties).map(([property, content]) => ({
                    tag: "meta", attrs: { property, content }, injectTo: "head" as const
                })),
                ...Object.entries(names).map(([name, content]) => ({
                    tag: "meta", attrs: { name, content }, injectTo: "head" as const
                }))
            ];
        }
    };
}

/**
 * Cloudflare Web Analytics の計測タグ。Cookie を置かず、訪問者を見分ける値も残さない
 * ので、同意の確認（Cookie バナー）は出さない。目録（index.html）にだけ入れる。プレイヤー
 * （play.html）は目録の iframe の中で開くので、入れると一回の訪問を二重に数える。
 * 作品ページ（/work/<id>/）は Worker が目録の HTML から作るので、そのまま入る。
 * pushState での移動も、タグが自分で拾ってページビューにする。
 *
 * トークンは秘密ではない（ページにそのまま載る）。Cloudflare のダッシュボードの
 * Web Analytics でサイトを足すときに、JS スニペットの方式を選ぶと出てくる。
 * 自動で差し込む方式を選ぶと、ここのタグと二重になる。空なら入れない。
 */
const WEB_ANALYTICS_TOKEN = "d8ea3305d807495caf327d9292401495";

function webAnalytics(): Plugin {
    return {
        name: "fanm-web-analytics",
        apply: "build",
        transformIndexHtml(html, ctx) {
            if (!WEB_ANALYTICS_TOKEN || !ctx.path.endsWith("/index.html")) return;
            // 属性の値に JSON の " が入るので、Vite のタグ組み立て（" を \" と書く）を通さず自分で書く。
            const beacon = JSON.stringify({ token: WEB_ANALYTICS_TOKEN }).replace(/"/g, "&quot;");
            return html.replace("</body>", () => `<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon="${beacon}"></script>\n</body>`);
        }
    };
}

export default defineConfig({
    base: "/",
    // 作品が日本語を出すためのドット面（JF Dot K12x10）。エンジンに同梱された
    // ものをそのまま配る。写しを持たないので、エンジンを更新すれば追従する。
    publicDir: root("engine/fantasy-msx/public"),
    plugins: [galleryDev(root("")), socialPreview(), webAnalytics()],
    resolve: {
        alias: [
            { find: /^fantasy-msx$/, replacement: root("engine/fantasy-msx/src/index.ts") },
            { find: /^fantasy-msx\/(.*)$/, replacement: root("engine/fantasy-msx/$1") },
            { find: /^@fanm\/work$/, replacement: root("packages/work/src/index.ts") }
        ]
    },
    server: {
        // templates/ をプレイヤーから読めるように
        fs: { allow: [root("")] }
    },
    build: {
        outDir: "dist",
        target: "es2022",
        rollupOptions: {
            input: { index: "index.html", play: "play.html" }
        }
    }
});
