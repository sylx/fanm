// 生成と修正の会話を組み立て、応答から work.ts と meta.json を取り出す。
//
// 会話はディスクに残したものから毎回組み立て直す。途中で落ちても同じ会話で続けられる。
//
//     system     制作ルール + API資料
//     user       generate.md（企画と実例）
//     assistant  attempt-1 の応答
//     user       repair.md（attempt-1 の検査結果）
//     assistant  attempt-2 の応答 ...

import type { WorkDescription } from "@fanm/work";
import type { Plan } from "../plan/planner.js";
import type { CompletionRequest, Message } from "../providers/provider.js";
import { personaPrompt, type Persona } from "../persona/persona.js";
import { formOf } from "../plan/forms.js";
import { fill, formBrief, prompt, system, template } from "../prompts.js";
import { avoidBrief, thin } from "./example.js";

export interface PastAttempt {
    readonly response: string;
    readonly stage: string;
    readonly problems: readonly string[];
    readonly observations: string;
}

export function generateRequest(
    plan: Plan,
    persona: Persona | undefined,
    past: readonly PastAttempt[],
    options: { maxOutputTokens: number; reasoningEffort: CompletionRequest["reasoningEffort"] }
): CompletionRequest {
    const example = template(formOf(plan.form).id);
    const messages: Message[] = [
        system(),
        {
            role: "user",
            content: fill(prompt("generate.md"), {
                form: formBrief(formOf(plan.form).id),
                plan: JSON.stringify(plan, null, 2),
                persona: personaPrompt(persona),
                // 実例はデータを抜いて渡す。そのまま渡すと写しが返ってくる。
                template: thin(example),
                avoid: avoidBrief(example)
            })
        }
    ];
    for (const attempt of past) {
        messages.push({ role: "assistant", content: attempt.response });
        messages.push({
            role: "user",
            content: fill(prompt("repair.md"), {
                stage: attempt.stage,
                problems: attempt.problems.map(p => `- ${p}`).join("\n"),
                observations: attempt.observations || "（撮影まで進まなかった）"
            })
        });
    }
    return { messages, ...options };
}

export interface GeneratedFiles {
    readonly work: string;
    readonly meta: WorkDescription;
}

/** 応答からファイルを取り出す。取り出せなければ、AIへ返す問題の一覧を投げる。 */
export function parseFiles(text: string, truncated: boolean): GeneratedFiles {
    const problems: string[] = [];
    if (truncated) problems.push("応答が出力上限で切れた。コードをもっと短くする。");

    const blocks = [...text.matchAll(/```(\w+)[^\n]*\n([\s\S]*?)```/g)];
    const work = blocks.find(b => b[1] === "ts" || b[1] === "typescript")?.[2];
    const metaText = blocks.find(b => b[1] === "json")?.[2];
    if (!work) problems.push("```ts work.ts のコードブロックがない。");
    if (!metaText) problems.push("```json meta.json のコードブロックがない。");

    let meta: WorkDescription | undefined;
    if (metaText) {
        try {
            const raw = JSON.parse(metaText) as Partial<WorkDescription>;
            for (const key of ["title", "description"] as const) {
                if (typeof raw[key] !== "string" || !raw[key]) problems.push(`meta.json に ${key} がない。`);
            }
            if (typeof raw.controls !== "string") problems.push("meta.json の controls は文字列にする（操作がなければ空文字）。");
            if (typeof raw.durationFrames !== "number") problems.push("meta.json の durationFrames は数値にする。");
            meta = raw as WorkDescription;
        } catch (e) {
            problems.push(`meta.json が JSON として読めない: ${(e as Error).message}`);
        }
    }
    if (problems.length || !work || !meta) throw new FormatError(problems);
    return { work, meta };
}

export class FormatError extends Error {
    constructor(readonly problems: readonly string[]) {
        super(problems.join("\n"));
    }
}
