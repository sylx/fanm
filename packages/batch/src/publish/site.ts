// 作品庫から公開物を組み立てる。<VAR>/site/ がそのまま公開する中身になる。
//
// 増えた作品と、まだ無いエンジンだけをビルドする。目録は毎回書き直すが、
// これは小さなJSONひとつなので安い。ギャラリーの殻（index.html など）は
// gallery パッケージのビルドを写す。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    /** 殻が持たなくなったので消したもの。 */
    readonly removed: string[];
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

    const removed = copyShell(siteDir);
    writeFileSync(join(siteDir, "_headers"), HEADERS);
    return { works: catalog.length, built, engines, removed };
}

/**
 * 配り方の指示。Cloudflare が読み、この中身自体は配られない。
 *
 * エンジン、ギャラリーの JS、ドット面は名前に中身が織り込まれていて（コミット、
 * ビルドのハッシュ、固定の名前）、一度出したものは変わらない。ずっと持っていてよい。
 * 目録と作品は publish のたびに増えるので、既定のまま毎回確かめさせる。
 */
const HEADERS = `/engine/*
  Cache-Control: public, max-age=31536000, immutable
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/fonts/*
  Cache-Control: public, max-age=31536000, immutable
`;

/** 目録は最後に、一息で置き換える。読み手が半端な目録を見ないように。 */
function writeAtomic(path: string, content: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(`${path}.tmp`, content);
    renameSync(`${path}.tmp`, path);
}

/** ギャラリーの殻を写す。作品とエンジンには触らない。消したものを返す。 */
function copyShell(siteDir: string): string[] {
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
    return prune(siteDir);
}

/** 殻の外で増えていくもの。掃除の対象にしない。 */
const KEEP = new Set(["works", "engine", "_headers"]);

/**
 * 殻が持たなくなったものを消す。ギャラリーをビルドし直すと assets/ の名前が
 * 変わるので、誰からも読まれない古い版が公開物に積もっていく。作品とエンジンは
 * 殻の側から見れば知らないものなので、ここでは触らない（KEEP）。
 */
function prune(dir: string, relative = ""): string[] {
    const removed: string[] = [];
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
        const path = join(relative, entry.name);
        if (!relative && KEEP.has(entry.name)) continue;
        if (existsSync(join(SHELL, path))) {
            if (entry.isDirectory()) removed.push(...prune(dir, path));
            continue;
        }
        rmSync(join(dir, path), { recursive: true });
        removed.push(path);
    }
    return removed;
}
