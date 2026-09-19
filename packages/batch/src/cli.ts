#!/usr/bin/env -S npx tsx
// fanM の入口。
//
//     fanm check <作品ディレクトリ>   作品を一つヘッドレスで動かし、撮影して var/check/ に置く
//     fanm run                         （未実装）スケジューラーを起動して制作を回し続ける
//     fanm publish                     （未実装）公開待ちキューをアップロードする

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { encodePNG } from "fantasy-msx/tools/png.js";
import type { Scenario, WorkDescription, WorkFactory } from "@fanm/work";
import { runHeadless } from "./check/headless.js";

async function check(dir: string): Promise<number> {
    const root = resolve(dir);
    const meta = JSON.parse(readFileSync(join(root, "meta.json"), "utf8")) as WorkDescription;
    const factory = (await import(pathToFileURL(join(root, "work.ts")).href)).default as WorkFactory;

    const frames = meta.durationFrames;
    const scenario: Scenario = {
        seed: 1,
        frames,
        captures: [60, Math.floor(frames / 2), frames - 1],
        inputs: []
    };
    const result = runHeadless(factory, scenario);

    const out = resolve("var/check", basename(root));
    mkdirSync(out, { recursive: true });
    for (const { frame, image } of result.captures) {
        writeFileSync(join(out, `${frame}.png`), encodePNG(image.pixels, image.width, image.height));
    }
    if (!result.ok) {
        console.error(`${meta.title}: frame ${result.frame} で失敗\n${result.error}`);
        return 1;
    }
    console.log(`${meta.title}: ${frames} フレーム実行、${result.captures.length} 枚を ${out} に保存`);
    return 0;
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
    case "check":
        if (!args[0]) throw new Error("usage: fanm check <dir>");
        process.exitCode = await check(args[0]);
        break;
    default:
        console.error("usage: fanm check <dir>");
        process.exitCode = 2;
}
