import type { CatalogEntry } from "../src/catalog-entry.js";
import { renderWork } from "./render.js";

export interface Env {
    ASSETS: { fetch(request: Request): Promise<Response> };
    VERSION?: { id: string };
    /** 作品ごとの再生回数（Workers Analytics Engine）。開発サーバーとテストには無く、そのときは数えない。 */
    PLAYS?: { writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void };
}

/** 再生がどこから来たか。目録で選んだ、ランダム再生で回ってきた、プレイヤーを直接開いた。 */
const VIA = new Set(["pick", "auto", "direct"]);

/**
 * プレイヤーが作品を動かし始めたときに送ってくる知らせを数える。
 *
 * 目録から作品へは pushState で移るので、/work/ の HTML は直接開かれたときにしか
 * Worker を通らない。だから数えるのはプレイヤーの側からの知らせにする。
 *
 * 残すのは作品、経路、国だけ。IP、User-Agent、Cookie のような、人を見分けられる
 * ものは受け取らず、残さない。知らない作品は数えない（目録を汚させない）。
 */
async function countPlay(request: Request, url: URL, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    const id = url.searchParams.get("work") ?? "";
    const via = url.searchParams.get("via") ?? "";
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !VIA.has(via)) return new Response("Bad request", { status: 400 });
    const meta = await env.ASSETS.fetch(new Request(new URL(`/works/${id}/meta.json`, url.origin)));
    if (!meta.ok) return new Response("Not found", { status: 404 });
    const country = (request as Request & { cf?: { country?: string } }).cf?.country ?? "";
    env.PLAYS?.writeDataPoint({ indexes: [id], blobs: [id, via, country], doubles: [1] });
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
interface Context { waitUntil(promise: Promise<unknown>): void }

/** Web 標準だけに依存し、開発サーバーからも同じハンドラを実行する。 */
export async function handle(request: Request, env: Env, context?: Context): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/play") return countPlay(request, url, env);
    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
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
