// プレイヤー。iframe の中で作品を一つだけ動かす。
//
// 公開時の作品は works/<id>/work.js。エンジンは含まれておらず、作品自身が
// 自分の作られた版の engine/<commit>.js を import する。プレイヤーも同じ版を
// 読んで動かす。だからエンジンを更新しても、過去の作品はビルドし直さずに動く。
//
// ここでエンジンを静的に import してはいけない。プレイヤーの中に二つ目の
// エンジンが入り、作品と別のエンジンで動くことになる。
//
// 開発中は、まだビルドしていない手元の作品やテンプレートも直接読める。

import { createEnv, type WorkFactory } from "@fanm/work";
import type { CatalogEntry } from "./catalog-entry.js";

type Engine = typeof import("fantasy-msx");

interface Loaded {
    readonly factory: WorkFactory;
    readonly seed: number;
    readonly engine: Engine;
}

const url = (path: string) => new URL(path, location.href).href;

async function fromCatalog(id: string): Promise<Loaded | null> {
    const response = await fetch("works/index.json").catch(() => null);
    if (!response?.ok) return null;
    const entry = ((await response.json()) as CatalogEntry[]).find(w => w.id === id);
    if (!entry) return null;
    const [work, engine] = await Promise.all([
        import(/* @vite-ignore */ url(entry.work)),
        import(/* @vite-ignore */ url(`engine/${entry.engine.slice(0, 12)}.js`)) as Promise<Engine>
    ]);
    return { factory: work.default as WorkFactory, seed: entry.seed, engine };
}

/** 開発サーバーのときだけ。本番のビルドには含まれない。 */
async function fromDisk(id: string): Promise<Loaded | null> {
    if (!import.meta.env.DEV) return null;
    const { load } = await import("./dev-works.js");
    const factory = await load(id);
    if (!factory) return null;
    return { factory, seed: 1, engine: await import("fantasy-msx") };
}

const params = new URLSearchParams(location.search);
const id = params.get("work") ?? "minimal";
const found = (await fromCatalog(id)) ?? (await fromDisk(id));
if (!found) throw new Error(`作品 ${id} が見つからない`);

const seed = params.has("seed") ? Number(params.get("seed")) : found.seed;
found.engine.run(found.factory(createEnv(seed)), {
    canvas: document.querySelector("canvas") as HTMLCanvasElement
});
