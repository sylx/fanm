// 縛り（しばり）の札束。企画のたびに数枚引き、その条件の中で考えさせる。
//
// 型（form）を決めても、AIは放っておくと同じ作品に寄る。「過去作と違うものを」と
// 頼むだけでは、設定（題材や名前）だけを変えて、段取りは前と同じものを出してくる。
// だから、段取りそのものを縛る札をこちらで引いて渡す。引くのはジョブの種なので、
// 同じジョブは何度やり直しても同じ縛りになる。
//
// 札は「何を作るか」ではなく「どう作るか」を縛るものにする。題材を指定する札より、
// 「動きはパレット書き換えだけで作る」のように、コードの形が変わる札が効く。
//
// 札そのものはコードではなく templates/ にある（plan/season.ts）。どの型にも引く札は
// templates/season.json の common、型ごとの札は templates/<型>/twists.json。
// 札は月に一度作り変える。固定のままだと、札の文句がそのまま題に写りはじめる。

import { formOf } from "./forms.js";
import type { Plan } from "./planner.js";
import { season, type Axis } from "./season.js";

export interface Twist {
    readonly axis: string;
    readonly option: string;
}

/** 企画に残っている縛りを、`軸: 札` の形で読む。 */
function used(past: readonly Plan[], form: string, depth: number): Set<string> {
    const set = new Set<string>();
    for (const plan of past.filter(p => formOf(p.form).id === form).slice(0, depth)) {
        for (const t of plan.twist ?? []) set.add(`${t.axis}: ${t.option}`);
    }
    return set;
}

function pick<T>(items: readonly T[], random: () => number): T | undefined {
    return items[Math.floor(random() * items.length)];
}

/** 引く順を混ぜる。どの軸も同じ確からしさで選ばれるように。 */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * 今回の縛りを引く。型の札から2枚、共通の札から2枚。
 *
 * 同じ型の直近の作品で使った札は避ける。避けると何も残らない軸は、そのまま引く
 * （札束が尽きたときに企画が止まらないように）。
 */
export function drawTwist(form: string, past: readonly Plan[], random: () => number): Twist[] {
    const seen = used(past, form, 4);
    const draw = (axes: readonly Axis[], count: number): Twist[] => {
        return shuffled(axes, random).slice(0, count).map(axis => {
            const fresh = axis.options.filter(o => !seen.has(`${axis.name}: ${o}`));
            const option = pick(fresh.length ? fresh : axis.options, random)!;
            return { axis: axis.name, option };
        });
    };
    // 型の作法とぶつかる共通の札は、その型には引かない（キャラクタ画面にはビットマップの
    // モードも、描き足しも無い）。どれを外すかは templates/<型>/twists.json の skipCommon。
    const { common, byForm, skipCommon } = season();
    const skip = skipCommon[form] ?? [];
    return [...draw(byForm[form] ?? [], 2), ...draw(common.filter(axis => !skip.includes(axis.name)), 2)];
}

/** 企画の頼みに入れる文。 */
export function twistBrief(twist: readonly Twist[]): string {
    if (!twist.length) return "（なし）";
    return twist.map(t => `- **${t.axis}**: ${t.option}`).join("\n");
}
