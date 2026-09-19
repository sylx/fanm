// 企画。過去作品の短い要約と制作ルールから、次の企画を決める。
// 過去の全コードや会話履歴は渡さない。

import type { CompletionRequest } from "../providers/provider.js";
import { fill, prompt, system } from "../prompts.js";

export interface Plan {
    readonly title: string;
    readonly pitch: string;
    /** 偏りを避けるための軸。過去作品の要約にも同じ軸で並べる。 */
    readonly subject: string;
    readonly motion: string;
    readonly composition: string;
    readonly sound: string;
    readonly msxFeatures: readonly string[];
    readonly interactive: boolean;
    readonly durationFrames: number;
}

/** 過去作品一覧の一行。 */
export function summarize(plan: Plan): string {
    return `- ${plan.title}: 題材=${plan.subject} / 動き=${plan.motion} / 構図=${plan.composition} / 音=${plan.sound} / 機能=${plan.msxFeatures.join(",")}`;
}

export function planRequest(past: readonly Plan[], maxOutputTokens: number): CompletionRequest {
    const list = past.length ? past.map(summarize).join("\n") : "（まだない）";
    return {
        messages: [system(), { role: "user", content: fill(prompt("plan.md"), { past: list }) }],
        maxOutputTokens,
        reasoningEffort: "none",
        json: true
    };
}

export function parsePlan(text: string): Plan {
    const raw = JSON.parse(text) as Partial<Plan>;
    const str = (key: keyof Plan) => {
        const value = raw[key];
        if (typeof value !== "string" || !value.trim()) throw new Error(`企画に ${key} がない`);
        return value.trim();
    };
    return {
        title: str("title"),
        pitch: str("pitch"),
        subject: str("subject"),
        motion: str("motion"),
        composition: str("composition"),
        sound: str("sound"),
        msxFeatures: Array.isArray(raw.msxFeatures) ? raw.msxFeatures.map(String) : [],
        interactive: raw.interactive === true,
        durationFrames: Number(raw.durationFrames) || 2400
    };
}
