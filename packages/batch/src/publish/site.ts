// 作品庫から公開物を組み立てる。<VAR>/site/ がそのまま公開する中身になる。
//
// 増えた作品と、まだ無いエンジンだけをビルドする。目録は毎回書き直すが、
// これは小さなJSONひとつなので安い。ギャラリーの殻（index.html など）は
// gallery パッケージのビルドを写す。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkMeta } from "@fanm/work";
import { buildEngine, buildWork } from "./build.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
const SHELL = join(ROOT, "packages/gallery/dist");

export interface CatalogEntry extends WorkMeta {
    /** 目録から見た、作品とサムネイルの場所。 */
    readonly work: string;
    readonly thumb: string;
}

export interface AssembleResult {
    readonly works: number;
    readonly built: string[];
    readonly engines: string[];
}

/** 作品庫の中身。public/meta.json があるものだけを作品とみなす。 */
function archived(worksDir: string): { id: string; dir: string; meta: WorkMeta }[] {
    if (!existsSync(worksDir)) return [];
    return readdirSync(worksDir)
        .map(id => ({ id, dir: join(worksDir, id, "public") }))
        .filter(w => existsSync(join(w.dir, "meta.json")))
        .map(w => ({ ...w, meta: JSON.parse(readFileSync(join(w.dir, "meta.json"), "utf8")) as WorkMeta }));
}

/** 作品のソースより古いビルドは作り直す。ふだんは触らない。 */
function stale(source: string, output: string): boolean {
    if (!existsSync(output)) return true;
    return statSync(source).mtimeMs > statSync(output).mtimeMs;
}

export async function assemble(worksDir: string, siteDir: string): Promise<AssembleResult> {
    mkdirSync(siteDir, { recursive: true });
    const works = archived(worksDir);
    const built: string[] = [];
    const engines: string[] = [];

    for (const commit of new Set(works.map(w => w.meta.engine))) {
        if (await buildEngine(commit, siteDir)) engines.push(commit.slice(0, 12));
    }

    for (const work of works) {
        const source = join(work.dir, "work.ts");
        if (stale(source, join(siteDir, "works", work.id, "work.js"))) {
            await buildWork(source, work.id, work.meta.engine, siteDir);
            built.push(work.id);
        }
        const thumb = join(work.dir, "thumbnail.png");
        const outThumb = join(siteDir, "works", work.id, "thumb.png");
        if (existsSync(thumb) && stale(thumb, outThumb)) copyFileSync(thumb, outThumb);
    }

    const catalog: CatalogEntry[] = works
        .map(w => ({ ...w.meta, work: `works/${w.id}/work.js`, thumb: `works/${w.id}/thumb.png` }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    writeAtomic(join(siteDir, "works", "index.json"), JSON.stringify(catalog, null, 2));

    copyShell(siteDir);
    return { works: catalog.length, built, engines };
}

/** 目録は最後に、一息で置き換える。読み手が半端な目録を見ないように。 */
function writeAtomic(path: string, content: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(`${path}.tmp`, content);
    renameSync(`${path}.tmp`, path);
}

/** ギャラリーの殻を写す。作品とエンジンには触らない。 */
function copyShell(siteDir: string): void {
    if (!existsSync(SHELL)) throw new Error(`ギャラリーがビルドされていない。先に npm run gallery:build（${SHELL}）`);
    const walk = (from: string, to: string): void => {
        mkdirSync(to, { recursive: true });
        for (const entry of readdirSync(from, { withFileTypes: true })) {
            const source = join(from, entry.name);
            const target = join(to, entry.name);
            if (entry.isDirectory()) walk(source, target);
            else if (stale(source, target)) copyFileSync(source, target);
        }
    };
    walk(SHELL, siteDir);
}
