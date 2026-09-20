import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/**
 * 作品庫を見張る。<VAR>/works/ は vite の管理下の外にあるので、作品が増えても
 * dev-catalog.ts / dev-works.ts の glob は古いままになる。作った作品が
 * 開発サーバーに出てこないので、増減を見つけたら読み直させる。
 */
function watchArchive(): Plugin {
    const archive = root("var/works");
    const dependents = ["src/dev-catalog.ts", "src/dev-works.ts"].map(file => root(`packages/gallery/${file}`));

    return {
        name: "fanm-watch-archive",
        apply: "serve",
        configureServer(server) {
            server.watcher.add(archive);
            const changed = (path: string) => {
                if (!path.startsWith(archive)) return;
                for (const file of dependents) {
                    const module = server.moduleGraph.getModuleById(file);
                    if (module) server.moduleGraph.invalidateModule(module);
                }
                server.ws.send({ type: "full-reload" });
            };
            server.watcher.on("add", changed);
            server.watcher.on("unlink", changed);
        }
    };
}

export default defineConfig({
    base: "./",
    plugins: [watchArchive()],
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
