import type { CatalogEntry } from "../src/catalog-entry.js";
import { renderWork } from "./render.js";

export interface Env {
    ASSETS: { fetch(request: Request): Promise<Response> };
    VERSION?: { id: string };
}
interface Context { waitUntil(promise: Promise<unknown>): void }

/** Web 標準だけに依存し、開発サーバーからも同じハンドラを実行する。 */
export async function handle(request: Request, env: Env, context?: Context): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/work/")) return env.ASSETS.fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const match = /^\/work\/([a-zA-Z0-9_-]+)\/?$/.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });
    if (!url.pathname.endsWith("/")) {
        url.pathname += "/";
        return Response.redirect(url.href, 308);
    }
    const id = match[1];
    const cache = (globalThis.caches as CacheStorage & { default?: Cache } | undefined)?.default;
    const cacheURL = new URL(`/__work-cache/${env.VERSION?.id}/${id}`, url.origin);
    const key = new Request(cacheURL);
    if (cache && env.VERSION) {
        const cached = await cache.match(key);
        if (cached) {
            const response = new Response(request.method === "HEAD" ? null : cached.body, cached);
            response.headers.set("Cache-Control", "public, max-age=0, must-revalidate");
            return response;
        }
    }
    const [meta, shell] = await Promise.all([
        env.ASSETS.fetch(new Request(new URL(`/works/${id}/meta.json`, url.origin))),
        env.ASSETS.fetch(new Request(new URL("/", url.origin)))
    ]);
    if (!shell.ok) return new Response("Gallery unavailable", { status: 503 });
    if (!meta.ok && meta.status !== 404) return new Response("Work unavailable", { status: 503 });
    const entry = meta.ok ? await meta.json() as CatalogEntry : null;
    const response = new Response(renderWork(await shell.text(), entry), {
        status: entry ? 200 : 404,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=0, must-revalidate" }
    });
    if (entry && cache && env.VERSION && context) {
        const stored = response.clone();
        stored.headers.set("Cache-Control", "public, max-age=3600");
        // ブラウザ用の再検証方針はキャッシュから取り出した際にも維持する。
        context.waitUntil(cache.put(key, stored));
    }
    return request.method === "HEAD" ? new Response(null, response) : response;
}

export default { fetch: handle };
