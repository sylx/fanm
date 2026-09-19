// プレイヤー。iframe の中で作品を一つだけ動かす。
//
// 公開時の作品は、fantasy-msx を外部依存としてビルドした works/<id>/work.js。
// エンジンは作品の meta.engine に合う版を import map で渡す（TODO）。
// いまは開発用に templates/ の作品を直接読み込める。

import { run } from "fantasy-msx";
import { createEnv, type WorkFactory } from "@fanm/work";

const templates = import.meta.glob<{ default: WorkFactory }>("../../../templates/*/work.ts");

async function resolve(id: string): Promise<WorkFactory> {
    const template = templates[`../../../templates/${id}/work.ts`];
    if (template) return (await template()).default;
    // ページ基準のURLにしてから読む。文字列テンプレートのままだと vite の依存走査が解決しようとして落ちる
    const url = new URL(`works/${encodeURIComponent(id)}/work.js`, location.href).href;
    return (await import(/* @vite-ignore */ url)).default;
}

const params = new URLSearchParams(location.search);
const id = params.get("work") ?? "minimal";
const seed = Number(params.get("seed") ?? 1);
const factory = await resolve(id);
run(factory(createEnv(seed)), { canvas: document.querySelector("canvas") as HTMLCanvasElement });
