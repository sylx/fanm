// 企画。過去作品の短い要約と制作ルールから、次の企画を決める。
// 過去の全コードや会話履歴は渡さない。

import { IMAGE_NAME } from "@fanm/work";
import type { Picture } from "../paint/paint.js";
import type { Aspect } from "../providers/painter.js";
import type { CompletionRequest } from "../providers/provider.js";
import { personaPrompt, type Persona } from "../persona/persona.js";
import { fill, formBrief, prompt, system } from "../prompts.js";
import { formOf, type Form } from "./forms.js";
import { departmentOf } from "./season.js";
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
    /** 部門（departments/）の作品なら、その名前（"d"）。型に掛け合わせる印で、バッチが決める。 */
    readonly department?: string;
    /** 描かせる絵（D部門だけ）。企画が書き、描く段（paint/）が描いて作品に同梱する。 */
    readonly pictures?: readonly Picture[];
}

/** 絵を頼む部門か。いまは D部門だけ。 */
export function wantsPictures(department: string | undefined): boolean {
    return department === "d";
}

/** 一作品に頼む絵の数の上限。一枚 30 秒ほどかかり、作品の容量にもなる。 */
export const MAX_PICTURES = 2;

const ASPECTS: readonly Aspect[] = ["4:3", "1:1", "3:4", "16:9"];

/** 企画の pictures を読む。読めなければ、企画を頼み直す理由を投げる。 */
function parsePictures(raw: unknown): Picture[] {
    if (!Array.isArray(raw) || !raw.length) throw new Error("企画に pictures がない（D部門の作品は絵を1〜2枚頼む）");
    if (raw.length > MAX_PICTURES) throw new Error(`pictures が ${raw.length} 枚ある（${MAX_PICTURES} 枚まで）`);
    const seen = new Set<string>();
    return raw.map((p, i) => {
        const { name, prompt, aspect } = (p ?? {}) as Partial<Picture>;
        if (typeof name !== "string" || !IMAGE_NAME.test(name)) throw new Error(`pictures[${i}].name は英小文字で始まる英小文字・数字・_ にする`);
        if (seen.has(name)) throw new Error(`pictures の name ${name} が二つある`);
        seen.add(name);
        if (typeof prompt !== "string" || !prompt.trim()) throw new Error(`pictures[${i}].prompt がない`);
        const shape = aspect === undefined ? "4:3" : aspect;
        if (!ASPECTS.includes(shape)) throw new Error(`pictures[${i}].aspect は ${ASPECTS.join(" / ")} のどれか`);
        return { name, prompt: prompt.trim().slice(0, 2000), aspect: shape };
    });
}

/** 企画の頼みの「条件」に入れる、素材の決まり。 */
function assetsRule(department: string | undefined): string {
    return wantsPictures(department)
        ? "- 絵は企画の `pictures` で頼んだものが描かれて同梱される。それ以外の画像・音声ファイルや外部サービスは使えない。音は MML と PSG / FM 音源で作る。"
        : "- 画像・音声ファイルや外部サービスは使えない。絵は描画命令と点の配列、音は MML と PSG / FM 音源で作る。";
}

/** 企画の頼みの「出力」に足す一文。 */
function picturesRule(department: string | undefined): string {
    return wantsPictures(department)
        ? "D部門の作品なので、この JSON に `pictures`（描かせる絵、1〜2枚）も足してください。書き方は型の手引きのあとの「この作品はD部門」の「絵を頼む」にあります。"
        : "";
}

/** 過去作品一覧の角括弧。型と、部門の作品なら部門（「環境デモ・D部門」）。 */
function kind(plan: Plan): string {
    const outside = departmentOf(plan.department);
    return outside ? `${formOf(plan.form).label}・${outside.label}` : formOf(plan.form).label;
}

/** 過去作品一覧の一行。型も見せる。同じ型の中でも違うものを作らせるため。 */
export function summarize(plan: Plan): string {
    return `- [${kind(plan)}] ${plan.title}: 題材=${plan.subject} / 動き=${plan.motion}`
        + ` / 構図=${plan.composition} / 音=${plan.sound}`
        + (plan.structure ? ` / 段取り=${plan.structure}` : "")
        + ` / 機能=${plan.msxFeatures.join(",")}`;
}

/** 古い過去作の一行。題と題材だけ。 */
function summarizeBriefly(plan: Plan): string {
    return `- [${kind(plan)}] ${plan.title}: 題材=${plan.subject}`;
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
    /** 部門の作品なら、その名前。型の手引きに部門の手引きを足し、絵を頼ませる。 */
    department: string | undefined,
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
        form: formBrief(form.id, department),
        twist: twistBrief(twist),
        persona: personaPrompt(persona),
        assets: assetsRule(department),
        pictures: picturesRule(department)
    }).replace(/\n{3,}/g, "\n\n").trim();
    return {
        messages: [system(), { role: "user", content }],
        maxOutputTokens,
        reasoningEffort: "none",
        temperature,
        json: true
    };
}

/** 型はAIに選ばせない。渡されたものをそのまま企画に入れる。 */
export function parsePlan(text: string, form: Form, twist: readonly Twist[] = [], department?: string): Plan {
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
        season: season().season,
        ...(department ? { department } : {}),
        ...(wantsPictures(department) ? { pictures: parsePictures(raw.pictures) } : {})
    };
}
