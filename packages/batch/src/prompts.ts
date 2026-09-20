// prompts/ の資料を読み、AIへの会話を組み立てる。
//
// system は制作ルールと API 資料だけにして、企画・生成・修正のどれでも
// 同じにする。先頭が揃うので DeepSeek の入力キャッシュが効く。

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Message } from "./providers/provider.js";

const ROOT = resolve(import.meta.dirname, "../../..");

export function prompt(name: string): string {
    return readFileSync(join(ROOT, "prompts", name), "utf8");
}

export function fill(template: string, values: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        if (!(key in values)) throw new Error(`{{${key}}} に入れる値がない`);
        return values[key];
    });
}

export function system(): Message {
    return { role: "system", content: `${prompt("rules.md")}\n\n${prompt("api.md")}` };
}

/** 型の手引き。templates/<form>/form.md。 */
export function formBrief(form: string): string {
    return readFileSync(join(ROOT, "templates", form, "form.md"), "utf8").trim();
}

/** 型の実例。templates/<form>/work.ts。 */
export function template(form: string): string {
    return readFileSync(join(ROOT, "templates", form, "work.ts"), "utf8");
}
