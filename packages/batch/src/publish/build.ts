// 公開用のビルド。毎回すべてを作り直さないための決まりごとがここにある。
//
//     engine/<commit>.js    エンジン。コミットごとに一つ。作品より先に置く
//     works/<id>/work.js    作品。エンジンは含めず、上を import する
//     works/<id>/thumb.png  サムネイル
//     works/index.json      目録。新しい順
//
// 作品は一度ビルドしたら作り直さない。エンジンを更新しても、過去の作品は
// 自分が作られたときのコミットの engine を読むので、そのまま動き続ける。

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const ROOT = resolve(import.meta.dirname, "../../../..");
const ENGINE_ENTRY = join(ROOT, "engine/fantasy-msx/src/index.ts");
const TSCONFIG = join(ROOT, "tsconfig.base.json");

/** 公開物の中でのエンジンの置き場所。作品からは相対で辿る。 */
export const enginePath = (commit: string) => `engine/${commit.slice(0, 12)}.js`;

/** そのコミットのエンジンを一度だけ束ねる。すでにあれば何もしない。 */
export async function buildEngine(commit: string, siteDir: string): Promise<boolean> {
    const out = join(siteDir, enginePath(commit));
    if (existsSync(out)) return false;
    mkdirSync(join(siteDir, "engine"), { recursive: true });
    await build({
        entryPoints: [ENGINE_ENTRY],
        outfile: out,
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        minify: true,
        tsconfig: TSCONFIG,
        logLevel: "silent"
    });
    return true;
}

/**
 * 作品を一つ束ねる。エンジンは外に出し、`../../engine/<commit>.js` への
 * import として残す。`@fanm/work` は型だけなので、使っていれば一緒に入る。
 */
export async function buildWork(workPath: string, id: string, commit: string, siteDir: string): Promise<void> {
    const dir = join(siteDir, "works", id);
    mkdirSync(dir, { recursive: true });
    await build({
        entryPoints: [workPath],
        outfile: join(dir, "work.js"),
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        minify: true,
        tsconfig: TSCONFIG,
        logLevel: "silent",
        plugins: [{
            name: "engine-external",
            setup(builder) {
                builder.onResolve({ filter: /^fantasy-msx$/ }, () => ({
                    path: `../../${enginePath(commit)}`,
                    external: true
                }));
            }
        }]
    });
}
