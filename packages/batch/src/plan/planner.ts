// 企画。過去作品の短い要約と制作ルールから、次の企画を決める。
// 過去の全コードや会話履歴は渡さない。

import type { CompletionRequest } from "../providers/provider.js";
import { personaPrompt, type Persona } from "../persona/persona.js";
import { fill, formBrief, prompt, system } from "../prompts.js";
import { formOf, type Form } from "./forms.js";
import { twistBrief, type Twist } from "./variations.js";

export interface Plan {
    /** 作品の型（templates/<id>）。AIではなくバッチが決める。 */
    readonly form: string;
    readonly title: string;
    readonly pitch: string;
    /** 偏りを避けるための軸。過去作品の要約にも同じ軸で並べる。 */
    readonly subject: string;
    readonly motion: string;
    readonly composition: string;
    readonly sound: string;
    /** 段取り。画面の並びと状態の変わり方。設定ではなくコードの形が変わるところ。 */
    readonly structure: string;
    /** 今回の縛り。AIではなくバッチが引く。過去作の縛りを避けるために企画に残す。 */
    readonly twist?: readonly Twist[];
    readonly msxFeatures: readonly string[];
    readonly interactive: boolean;
    readonly durationFrames: number;
}

/** 過去作品一覧の一行。型も見せる。同じ型の中でも違うものを作らせるため。 */
export function summarize(plan: Plan): string {
    return `- [${formOf(plan.form).label}] ${plan.title}: 題材=${plan.subject} / 動き=${plan.motion}`
        + ` / 構図=${plan.composition} / 音=${plan.sound}`
        + (plan.structure ? ` / 段取り=${plan.structure}` : "")
        + ` / 機能=${plan.msxFeatures.join(",")}`;
}

export function planRequest(
    past: readonly Plan[],
    form: Form,
    twist: readonly Twist[],
    /** 作り手。性格を持たせる前のジョブには無い。 */
    persona: Persona | undefined,
    maxOutputTokens: number,
    /**
     * 企画は散らしたいが、上げすぎると日本語が壊れる。実測（DeepSeek V4 Pro、2026-09）:
     * 1.5 では sound と structure が文字の羅列になり、1.3 では JSON が壊れ、型の作法も
     * 外れた（RPG の企画にマウス操作が出た）。1.0 までなら通る。散らすのは縛り
     * （variations.ts）の役目にして、温度は上げない。
     */
    temperature = 1.0
): CompletionRequest {
    const list = past.length ? past.map(summarize).join("\n") : "（まだない）";
    const content = fill(prompt("plan.md"), {
        past: list,
        form: formBrief(form.id),
        twist: twistBrief(twist),
        persona: personaPrompt(persona)
    });
    return {
        messages: [system(), { role: "user", content }],
        maxOutputTokens,
        reasoningEffort: "none",
        temperature,
        json: true
    };
}

/** 型はAIに選ばせない。渡されたものをそのまま企画に入れる。 */
export function parsePlan(text: string, form: Form, twist: readonly Twist[] = []): Plan {
    const raw = JSON.parse(text) as Partial<Plan>;
    const str = (key: keyof Plan) => {
        const value = raw[key];
        if (typeof value !== "string" || !value.trim()) throw new Error(`企画に ${key} がない`);
        return value.trim();
    };
    return {
        form: form.id,
        title: str("title"),
        pitch: str("pitch"),
        subject: str("subject"),
        motion: str("motion"),
        composition: str("composition"),
        sound: str("sound"),
        structure: str("structure"),
        twist,
        msxFeatures: Array.isArray(raw.msxFeatures) ? raw.msxFeatures.map(String) : [],
        interactive: raw.interactive === true,
        durationFrames: Number(raw.durationFrames) || 2400
    };
}
