// 開発サーバー専用。まだ公開物を組み立てていなくても、手元の作品庫
// （<VAR>/works/）をそのまま一覧に出す。本番のビルドには含まれない。
//
// 公開時の目録は fanm publish が works/index.json に書く。こちらはそれを
// 待たずに見るためのもの。

import type { WorkMeta } from "@fanm/work";
import type { CatalogEntry } from "./catalog-entry.js";

const ARCHIVE = "../../../var/works";

const metas = import.meta.glob<WorkMeta>(`../../../var/works/*/public/meta.json`, { import: "default" });
const thumbs = import.meta.glob<string>(`../../../var/works/*/public/thumbnail.png`, { query: "?url", import: "default" });

export async function load(): Promise<CatalogEntry[]> {
    const entries = await Promise.all(Object.entries(metas).map(async ([path, read]) => {
        const id = path.slice(`${ARCHIVE}/`.length, -"/public/meta.json".length);
        const meta = await read();
        const thumb = thumbs[`${ARCHIVE}/${id}/public/thumbnail.png`];
        return { ...meta, work: `works/${id}/work.js`, thumb: thumb ? await thumb() : "" };
    }));
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
