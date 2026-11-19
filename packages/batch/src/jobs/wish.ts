// 型と部門の指定（--form、--department）を、これから作るジョブに当てる。
// fanm make と、常駐が「いま作れ」の頼みを受けたとき（run/loop.ts）の両方が使う。
//
// 当てるのは企画がまだのジョブにだけ。企画が済んでいれば、その型と部門のまま続ける
// （企画は型と部門を前提に書かれている）。

import type { Job, JobStore } from "./job.js";

export interface Wish {
    /** 型（templates/ のシーズンの型）。 */
    readonly form?: string;
    /** 部門（departments/）。d なら D部門。 */
    readonly department?: string;
}

export function applyWish(jobs: JobStore, job: Job, wish: Wish, log: (line: string) => void): void {
    if (!wish.form && !wish.department) return;
    const asked = [wish.form && `型 ${wish.form}`, wish.department && `部門 ${wish.department}`].filter(Boolean).join("、");
    if (job.plan) {
        log(`${job.id} は企画済みなので、${asked} の指定は効かない（型は ${job.form}${job.department ? `、部門は ${job.department}` : ""}）`);
        return;
    }
    if (wish.form) job.form = wish.form;
    if (wish.department) job.department = wish.department;
    jobs.save(job);
    log(`${job.id}: ${asked} を指定した`);
}
