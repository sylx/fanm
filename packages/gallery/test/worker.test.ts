import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogFiles } from "../server/catalog.js";
import { handle } from "../worker/index.js";
import { renderWork } from "../worker/render.js";
import type { CatalogEntry } from "../src/catalog-entry.js";

const entry: CatalogEntry = {
    id: "sample", title: '雨の街 </script><script>alert("x")</script>', description: '夜の <街> & "音"',
    createdAt: "2026-09-21T00:00:00Z", engine: "123456789012", seed: 7, controls: "", durationFrames: 600,
    thumbnail: "thumbnail.png", work: "/works/sample/work.js", thumb: "/works/sample/thumb.png"
};
const shell = '<html><head><title>fanM</title><meta property="og:title" content="site"><meta property="og:image:width" content="1200"></head><body><section id="work-info" hidden><h2></h2></section><script id="work-data" type="application/json">null</script></body></html>';

test("作品HTMLはJSなしで情報を持ち、作品由来のHTMLとscript終端をエスケープする", () => {
    const html = renderWork(shell, entry);
    assert.ok(html.includes("&lt;街&gt; &amp; &quot;音&quot;"));
    assert.equal((html.match(/property="og:title"/g) ?? []).length, 1);
    assert.ok(!html.includes("og:image:width"));
    assert.ok(html.includes('href="https://fanm.oyabanare.com/work/sample/"'));
    assert.ok(!html.includes('<script>alert'));
    const data = html.match(/<script id="work-data" type="application\/json">(.*?)<\/script>/)![1];
    assert.deepEqual(JSON.parse(data), entry);
});

test("1万作品でもWorkerが読むのは作品メタと共通HTMLだけ", async () => {
    const calls: string[] = [];
    const env = { ASSETS: { async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        calls.push(path);
        return path === "/" ? new Response(shell) : Response.json(entry);
    } } };
    const response = await handle(new Request("https://example.test/work/sample/?page=999"), env);
    assert.equal(response.status, 200);
    assert.deepEqual(calls.sort(), ["/", "/works/sample/meta.json"]);
    assert.ok((await response.text()).includes("og:image"));
    const head = await handle(new Request("https://example.test/work/sample/", { method: "HEAD" }), env);
    assert.equal(await head.text(), "");
});

test("末尾スラッシュ、404、上流エラー、メソッドを区別する", async () => {
    const assets = (status: number) => ({ ASSETS: { async fetch(request: Request) {
        return new URL(request.url).pathname === "/" ? new Response(shell) : new Response(null, { status });
    } } });
    const redirect = await handle(new Request("https://example.test/work/sample?page=2"), assets(404));
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "https://example.test/work/sample/?page=2");
    const missing = await handle(new Request("https://example.test/work/missing/"), assets(404));
    assert.equal(missing.status, 404);
    assert.ok((await missing.text()).includes('content="noindex"'));
    assert.equal((await handle(new Request("https://example.test/work/sample/"), assets(500))).status, 503);
    assert.equal((await handle(new Request("https://example.test/work/sample/", { method: "POST" }), assets(200))).status, 405);
});

test("1万作品を小さい索引と96件以下の塊に分け、新作追加で既存の塊を保つ", () => {
    const entries = Array.from({ length: 10_000 }, (_, i) => ({ ...entry, id: `sample-${i}`, createdAt: new Date(Date.UTC(2020, 0, 1) + i * 60_000).toISOString() }));
    const first = catalogFiles(entries);
    assert.equal(first.index.items.length, 10_000);
    assert.equal(first.index.items[0].id, "sample-9999");
    assert.equal(first.index.items.at(-1)!.id, "sample-0");
    const paths = [...new Set(first.index.items.map(item => item.chunk))];
    assert.equal(paths.length, Math.ceil(10_000 / 96));
    for (const path of paths) assert.ok(JSON.parse(first.files.get(path)!).length <= 96);
    assert.ok(!("description" in first.index.items[0]));
    const second = catalogFiles([...entries, { ...entry, id: "new", createdAt: "2026-09-22T00:00:00Z" }]);
    for (const path of paths.slice(1)) assert.equal(second.files.get(path), first.files.get(path));
    assert.notEqual(second.index.revision, first.index.revision);
});

test("HTMLキャッシュは公開版ごとに分離し、ブラウザには再検証を要求する", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "caches");
    const stored = new Map<string, Response>();
    const pending: Promise<unknown>[] = [];
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: {
        async match(request: Request) { return stored.get(request.url)?.clone(); },
        async put(request: Request, response: Response) { stored.set(request.url, response); }
    } } });
    try {
        let reads = 0;
        const ASSETS = { async fetch(request: Request) {
            reads++;
            return new URL(request.url).pathname === "/" ? new Response(shell) : Response.json(entry);
        } };
        const request = new Request("https://example.test/work/sample/");
        const context = { waitUntil(promise: Promise<unknown>) { pending.push(promise); } };
        await handle(request, { ASSETS, VERSION: { id: "first" } }, context);
        await Promise.all(pending);
        const cached = await handle(request, { ASSETS, VERSION: { id: "first" } }, context);
        assert.equal(reads, 2);
        assert.equal(cached.headers.get("cache-control"), "public, max-age=0, must-revalidate");
        assert.ok((await cached.text()).includes("og:title"));
        await handle(request, { ASSETS, VERSION: { id: "second" } }, context);
        await Promise.all(pending);
        assert.equal(reads, 4);
    } finally {
        if (descriptor) Object.defineProperty(globalThis, "caches", descriptor);
        else Reflect.deleteProperty(globalThis, "caches");
    }
});
