// シーズン。いま使う型と、縛りの札束。コードではなく templates/ のデータとして持つ。
//
//     templates/season.json          シーズンの名前、使う型、休ませた型、どの型にも引く札
//     templates/<型>/twists.json     その型の札
//     templates/<型>/form.md         その型の手引き
//     templates/<型>/work.ts         その型の実例
//     templates/<型>/meta.json       実例の説明
//
// 型と札を固定のままにすると、札の言い回しがそのまま作品の題に写り、札の組み合わせを
// 使い切ったところで作品が似てくる（実測: 144作のころ、題が「回廊」「灯」「補色」
// 「逆流」に寄った。どれも札の文句）。だから月に一度、ここを作り変える
// （.github/workflows/season.yml と prompts/season.md）。作り変えてよいのは
// templates/ の中だけで、検査・予算・公開のコードには触らせない。
//
// 休ませた型（retired）のディレクトリは消さない。過去作の型の名前を出すのと、
// 重なりを測る（fanm overlap）のに使う。あとのシーズンで戻すこともできる。

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../..");
export const TEMPLATES = join(ROOT, "templates");

export interface Form {
    /** templates/<id>/ の名前であり、企画に残る名前。 */
    readonly id: string;
    /** 過去作品の一覧に出す短い名前。 */
    readonly label: string;
}

export interface Axis {
    /** 軸の名前。企画にもこの名前で残す。 */
    readonly name: string;
    readonly options: readonly string[];
}

export interface Season {
    /** シーズンの名前（2026-12 のような年月）。企画に残す。 */
    readonly season: string;
    /** いま引く型。 */
    readonly forms: readonly Form[];
    /** 休ませた型。引かないが、過去作の型として名前は出す。 */
    readonly retired: readonly Form[];
    /** どの型にも引く札。 */
    readonly common: readonly Axis[];
    /** 型ごとの札。 */
    readonly byForm: Readonly<Record<string, readonly Axis[]>>;
    /** 型の作法とぶつかるので、その型には引かない共通の札（軸の名前）。 */
    readonly skipCommon: Readonly<Record<string, readonly string[]>>;
}

function json(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
        throw new Error(`${path} を読めない: ${(e as Error).message}`);
    }
}

function forms(raw: unknown, where: string): Form[] {
    if (!Array.isArray(raw)) throw new Error(`${where} が配列でない`);
    return raw.map((f, i) => {
        const { id, label } = (f ?? {}) as Partial<Form>;
        if (typeof id !== "string" || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`${where}[${i}].id は英小文字・数字・ハイフンの名前にする`);
        if (typeof label !== "string" || !label.trim()) throw new Error(`${where}[${i}].label がない`);
        return { id, label };
    });
}

/** 札は一つの軸に三枚以上。二枚だと、直近を避けたときに毎回同じ札になる。 */
function axes(raw: unknown, where: string): Axis[] {
    if (!Array.isArray(raw)) throw new Error(`${where} が配列でない`);
    const seen = new Set<string>();
    return raw.map((a, i) => {
        const { name, options } = (a ?? {}) as Partial<Axis>;
        if (typeof name !== "string" || !name.trim()) throw new Error(`${where}[${i}].name がない`);
        if (seen.has(name)) throw new Error(`${where}: 軸「${name}」が二つある`);
        seen.add(name);
        if (!Array.isArray(options) || options.length < 3 || options.some(o => typeof o !== "string" || !o.trim())) {
            throw new Error(`${where}「${name}」: options は三枚以上の文にする`);
        }
        return { name, options: options as string[] };
    });
}

/**
 * シーズンを読んで確かめる。壊れていたら、何がどこで壊れているかを言って止まる。
 * 月次の作り変えが通ったかどうかは、まずここで決まる（fanm check --templates）。
 */
export function readSeason(dir = TEMPLATES): Season {
    const path = join(dir, "season.json");
    const raw = json(path) as Record<string, unknown>;
    if (typeof raw.season !== "string" || !/^\d{4}-\d{2}$/.test(raw.season)) throw new Error(`${path}: season は 2026-12 のような年月にする`);
    const active = forms(raw.forms, `${path}: forms`);
    const retired = forms(raw.retired ?? [], `${path}: retired`);
    if (active.length < 4) throw new Error(`${path}: 型は四つ以上にする（少ないと同じ型が続く）`);
    const ids = [...active, ...retired].map(f => f.id);
    const twice = ids.find((id, i) => ids.indexOf(id) !== i);
    if (twice) throw new Error(`${path}: 型 ${twice} が二度出てくる`);
    const common = axes(raw.common, `${path}: common`);
    if (common.length < 2) throw new Error(`${path}: common の軸は二つ以上にする（毎回二枚引く）`);

    const byForm: Record<string, readonly Axis[]> = {};
    const skipCommon: Record<string, readonly string[]> = {};
    for (const form of active) {
        for (const file of ["form.md", "work.ts", "meta.json", "twists.json"]) {
            if (!existsSync(join(dir, form.id, file))) throw new Error(`templates/${form.id}/${file} がない`);
        }
        const twistPath = join(dir, form.id, "twists.json");
        const twists = json(twistPath) as { axes?: unknown; skipCommon?: unknown };
        byForm[form.id] = axes(twists.axes, `${twistPath}: axes`);
        if (byForm[form.id].length < 2) throw new Error(`${twistPath}: 軸は二つ以上にする（毎回二枚引く）`);
        const skip = twists.skipCommon ?? [];
        if (!Array.isArray(skip) || skip.some(s => !common.some(a => a.name === s))) {
            throw new Error(`${twistPath}: skipCommon には common の軸の名前を書く`);
        }
        if (common.length - skip.length < 2) throw new Error(`${twistPath}: skipCommon で共通の軸が二つ未満になる`);
        skipCommon[form.id] = skip as string[];
    }
    return { season: raw.season, forms: active, retired, common, byForm, skipCommon };
}

let cached: Season | undefined;

/** いまのシーズン。一度読んだら持っておく（配り直すまで変わらない）。 */
export function season(): Season {
    return cached ??= readSeason();
}
