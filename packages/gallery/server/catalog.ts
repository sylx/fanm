import { createHash } from "node:crypto";
import type { CatalogEntry, CatalogIndex } from "../src/catalog-entry.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 20);

/** 古い順に区切るので、新作追加で更新されるのは末尾の塊と索引だけ。 */
export function catalogFiles(entries: readonly CatalogEntry[]): { index: CatalogIndex; files: Map<string, string> } {
    const sorted = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const files = new Map<string, string>();
    const items: CatalogIndex["items"][number][] = [];
    for (let start = 0; start < sorted.length; start += 96) {
        const group = sorted.slice(start, start + 96);
        const body = JSON.stringify(group);
        const chunk = `/works/catalog/${hash(body)}.json`;
        files.set(chunk, body);
        for (const entry of group) {
            files.set(`/works/${entry.id}/meta.json`, JSON.stringify(entry));
            const { id, title, createdAt, model } = entry;
            items.push({ id, title, createdAt, model, chunk });
        }
    }
    items.reverse();
    const index = { revision: hash(JSON.stringify(items)), items };
    files.set("/works/catalog.json", JSON.stringify(index));
    return { index, files };
}
