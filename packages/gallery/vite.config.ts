import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

export default defineConfig({
    base: "./",
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
