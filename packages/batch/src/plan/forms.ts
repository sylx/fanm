// 作品の型。企画のたびに一つ選び、その型の手引き（templates/<id>/form.md）と
// 実例（templates/<id>/work.ts）をAIへ渡す。
//
// 型を選ぶのはバッチの側で、AIではない。型を決めずに企画させると、何を作っても
// 「光る点が流れていく」ものに寄る。AIに選ばせても同じところへ戻る。だから
// 過去作に少ない型を先に当て、同じ数のものが並んだらその中から乱択する。
//
// 型の一覧はコードではなく templates/season.json にある（plan/season.ts）。
// 型を増やすには templates/<id>/ を作り、season.json の forms に一行足す。
// 新しい型は直近に一作も無いので、入れた直後はその型が続けて当たる。

import type { Plan } from "./planner.js";
import { season, type Form } from "./season.js";

export type { Form };

/** いま引く型（templates/season.json の forms）。 */
export function activeForms(): readonly Form[] {
    return season().forms;
}

/**
 * 名前から型を引く。休ませた型も引ける（過去作の型として名前を出すため）。
 * 型を記録する前の作品と、もう一覧に無い型は、最初の型として扱う。
 */
export function formOf(id: string | undefined): Form {
    const { forms, retired } = season();
    return forms.find(f => f.id === id) ?? retired.find(f => f.id === id) ?? forms[0];
}

/**
 * 次に作る型。直近の作品で少ないものから選ぶ。
 *
 * 数えるのは直近 `window` 作まで。ずっと昔まで数えると、一度偏った分を
 * いつまでも取り返そうとして、こんどは逆に偏る。
 */
export function pickForm(
    past: readonly Plan[],
    random: () => number,
    forms: readonly Form[] = activeForms(),
    window = forms.length * 3
): Form {
    const counts = new Map(forms.map(form => [form.id, 0]));
    // 休ませた型の過去作は数えない。数えると、いまの型のどれとも並ばない数が混じる。
    for (const plan of past.slice(0, window)) {
        if (plan.form && counts.has(plan.form)) counts.set(plan.form, counts.get(plan.form)! + 1);
    }
    const fewest = Math.min(...counts.values());
    const candidates = forms.filter(form => counts.get(form.id) === fewest);
    return candidates[Math.floor(random() * candidates.length)] ?? forms[0];
}
