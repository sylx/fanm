// 作品の型。企画のたびに一つ選び、その型の手引き（templates/<id>/form.md）と
// 実例（templates/<id>/work.ts）をAIへ渡す。
//
// 型を選ぶのはバッチの側で、AIではない。型を決めずに企画させると、何を作っても
// 「光る点が流れていく」ものに寄る。AIに選ばせても同じところへ戻る。だから
// 過去作に少ない型を先に当て、同じ数のものが並んだらその中から乱択する。
//
// 型を増やすには templates/<id>/ を作り、ここに一行足す。

import type { Plan } from "./planner.js";

export interface Form {
    /** templates/<id>/ の名前であり、企画に残る名前。 */
    readonly id: string;
    /** 過去作品の一覧に出す短い名前。 */
    readonly label: string;
}

export const FORMS: readonly Form[] = [
    { id: "ambient", label: "環境デモ" },
    { id: "game", label: "ゲーム" },
    { id: "poem", label: "詩" },
    { id: "adventure", label: "アドベンチャー" },
    { id: "rpg", label: "RPG" },
    { id: "action", label: "横スクロールアクション" },
    { id: "shooter", label: "縦スクロールシューティング" }
];

export const DEFAULT_FORM = FORMS[0];

export function formOf(id: string | undefined): Form {
    return FORMS.find(f => f.id === id) ?? DEFAULT_FORM;
}

/**
 * 次に作る型。直近の作品で少ないものから選ぶ。
 *
 * 数えるのは直近 `window` 作まで。ずっと昔まで数えると、一度偏った分を
 * いつまでも取り返そうとして、こんどは逆に偏る。
 */
export function pickForm(past: readonly Plan[], random: () => number, window = FORMS.length * 3): Form {
    const recent = past.slice(0, window);
    const counts = new Map(FORMS.map(form => [form.id, 0]));
    for (const plan of recent) {
        const id = formOf(plan.form).id;
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const fewest = Math.min(...counts.values());
    const candidates = FORMS.filter(form => counts.get(form.id) === fewest);
    return candidates[Math.floor(random() * candidates.length)] ?? DEFAULT_FORM;
}
