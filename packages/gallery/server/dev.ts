import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import type { CatalogEntry } from "../src/catalog-entry.js";
import { catalogFiles } from "./catalog.js";
import { handle } from "../worker/index.js";

/** Vite の変換・HMRと、本番の Worker ハンドラを一つのポートで使う。 */
export function galleryDev(root: string): Plugin {
    const archive = join(root, "var/works");
    return {
        name: "fanm-gallery-worker-dev",
        apply: "serve",
        configureServer(server) {
            let data: ReturnType<typeof catalogFiles> | undefined;
            const load = () => data ??= catalogFiles((existsSync(archive) ? readdirSync(archive) : []).flatMap(id => {
                const meta = join(archive, id, "public/meta.json");
                if (!existsSync(meta)) return [];
                return [{ ...JSON.parse(readFileSync(meta, "utf8")), work: `/works/${id}/work.js`, thumb: `/works/${id}/thumb.png` } as CatalogEntry];
            }));
            server.watcher.add(archive);
            server.watcher.on("all", (_event, path) => {
                if (!path.startsWith(archive + "/")) return;
                data = undefined;
                for (const file of ["src/dev-works.ts"]) {
                    const module = server.moduleGraph.getModuleById(join(root, "packages/gallery", file));
                    if (module) server.moduleGraph.invalidateModule(module);
                }
                server.ws.send({ type: "full-reload" });
            });
            server.middlewares.use(async (req, res, next) => {
                const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
                if (!url.pathname.startsWith("/work/") && !url.pathname.startsWith("/works/")) return next();
                try {
                    const request = new Request(url, { method: req.method });
                    const assets = {
                        async fetch(request: Request): Promise<Response> {
                            const path = new URL(request.url).pathname;
                            if (path === "/") {
                                const source = readFileSync(join(root, "packages/gallery/index.html"), "utf8");
                                return new Response(await server.transformIndexHtml(url.pathname, source));
                            }
                            const json = load().files.get(path);
                            if (json !== undefined) return new Response(json, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
                            const thumb = /^\/works\/([a-zA-Z0-9_-]+)\/thumb.png$/.exec(path);
                            if (thumb) {
                                const file = join(archive, thumb[1], "public/thumbnail.png");
                                if (existsSync(file)) return new Response(readFileSync(file), { headers: { "Content-Type": "image/png" } });
                            }
                            return new Response("Not found", { status: 404 });
                        }
                    };
                    const response = await handle(request, { ASSETS: assets });
                    res.statusCode = response.status;
                    response.headers.forEach((value, name) => res.setHeader(name, value));
                    res.end(req.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
                } catch (error) { next(error); }
            });
        }
    };
}
