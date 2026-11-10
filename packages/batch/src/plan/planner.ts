// 企画。過去作品の短い要約と制作ルールから、次の企画を決める。
// 過去の全コードや会話履歴は渡さない。

import type { CompletionRequest } from "../providers/provider.js";
import { personaPrompt, type Persona } from "../persona/persona.js";
import { fill, formBrief, prompt, system } from "../prompts.js";
import { formOf, type Form } from "./forms.js";
import { season } from "./season.js";
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
    /** 企画したときのシーズン（templates/season.json）。型と札を作り変えた効き目を、あとで比べるため。 */
    readonly season?: string;
}

/** 過去作品一覧の一行。型も見せる。同じ型の中でも違うものを作らせるため。 */
export function summarize(plan: Plan): string {
    return `- [${formOf(plan.form).label}] ${plan.title}: 題材=${plan.subject} / 動き=${plan.motion}`
        + ` / 構図=${plan.composition} / 音=${plan.sound}`
        + (plan.structure ? ` / 段取り=${plan.structure}` : "")
        + ` / 機能=${plan.msxFeatures.join(",")}`;
}

/** 古い過去作の一行。題と題材だけ。 */
function summarizeBriefly(plan: Plan): string {
    return `- [${formOf(plan.form).label}] ${plan.title}: 題材=${plan.subject}`;
}

/**
 * 過去作品の一覧。直近 `full` 作は軸をすべて並べ、それより古いものは題と題材だけにする。
 *
 * 同じ詳しさで並べられるのは40作ほどまで（実測: 40作で一覧だけで1万5千トークン）。
 * それより前の作品は見えないので、三か月前の題材に戻ってきても気づけなかった。
 * 段取りまで見比べたいのは近い作品で、古い作品は「その題材はもうやった」と分かれば
 * 足りる。詳しく並べる数を減らし、浮いた分で三倍の数の作品を覚えておく。
 */
export function pastBrief(past: readonly Plan[], full = 24): string {
    if (!past.length) return "（まだない）";
    const recent = past.slice(0, full).map(summarize);
    const older = past.slice(full).map(summarizeBriefly);
    return older.length ? `${recent.join("\n")}\n\nこれより前の作品（題と題材だけ）:\n\n${older.join("\n")}` : recent.join("\n");
}

/**
 * 使い古した語。直近の作品の題と題材に何度も出てくる漢字の語と片仮名の語。
 *
 * 「過去作と違うものを」と頼んでも、AIは気に入った語へ戻ってくる（実測: 直近45作の
 * 題に「回廊」が4回、「灯」が6回）。一覧を見せて避けさせるより、数えて名指しする
 * ほうが効く。数えるのはこちらなので、作品が入れ替われば語も入れ替わる。
 *
 * 二字以上の語は `min` 作、漢字一字はその倍の作品に出ていたら使い古しとみなす。
 * 一字は別の語の一部としても数える（「灯」は「灯台」「灯痕」にも出ている）。
 * 並べるのは語が先、字が後。語のほうが指すものがはっきりしている。語は `limit` 個、
 * 字はその半分まで。
 */
export function wornWords(past: readonly Plan[], depth = 48, min = 3, limit = 12): string[] {
    const texts = past.slice(0, depth).map(p => `${p.title} ${p.subject}`);
    const candidates = new Set<string>();
    for (const text of texts) {
        for (const m of text.matchAll(/[一-龠々]{2,}|[ァ-ヶー]{3,}/g)) candidates.add(m[0]);
        for (const m of text.matchAll(/[一-龠]/g)) if (!PLAIN.includes(m[0])) candidates.add(m[0]);
    }
    const counted = [...candidates]
        .map(word => ({ word, count: texts.filter(t => t.includes(word)).length }))
        .filter(c => c.count >= (c.word.length === 1 ? min * 2 : min))
        .sort((a, b) => b.count - a.count);
    const words = counted.filter(c => c.word.length > 1).slice(0, limit).map(c => c.word);
    // 「回廊」を挙げたなら「回」と「廊」は言わなくてよい。字は、語に入っていないものだけ。
    const letters = counted
        .filter(c => c.word.length === 1 && !words.some(w => w.includes(c.word)))
        .slice(0, Math.ceil(limit / 2))
        .map(c => c.word);
    return [...words, ...letters];
}

/** 位置や数を言うだけの字。何度出ても題材の偏りではない。 */
const PLAIN = "上下中内外前後左右大小一二三四五六七八九十百千見的";

/** 企画の頼みに入れる文。 */
export function wornBrief(words: readonly string[]): string {
    return words.length ? words.map(w => `「${w}」`).join(" ") : "（いまはない）";
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
    const content = fill(prompt("plan.md"), {
        past: pastBrief(past),
        worn: wornBrief(wornWords(past)),
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
        durationFrames: Number(raw.durationFrames) || 2400,
        season: season().season
    };
}
