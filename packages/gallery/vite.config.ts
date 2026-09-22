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

export default defineConfig({
    base: "/",
    // 作品が日本語を出すためのドット面（JF Dot K12x10）。エンジンに同梱された
    // ものをそのまま配る。写しを持たないので、エンジンを更新すれば追従する。
    publicDir: root("engine/fantasy-msx/public"),
    plugins: [galleryDev(root("")), socialPreview()],
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
