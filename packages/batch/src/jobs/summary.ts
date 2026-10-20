// 終わったジョブのまとめ。ログの一塊と、不採用の知らせに使う。
//
// 途中の出来事は一行ずつ流れていくので、コンテナのログだけ眺めていると
// 一作品が結局どうなったのかが散らばる。終わったところで、何を企画し、
// 何回試し、いくらかかり、どうなったかを一か所にまとめて書く。

import { formOf } from "../plan/forms.js";
import type { Job } from "./job.js";

export interface JobFacts {
    /** 企画の題。企画の前に止まったら undefined。 */
    readonly title?: string;
    readonly pitch?: string;
    readonly subject?: string;
    readonly form: string;
    /** 縛り。「軸=選んだもの」を「 / 」でつないだもの。 */
    readonly twist?: string;
    readonly author?: string;
    readonly model?: string;
    /** 試行ごとの結果。「1: typecheck 不合格 → 2: 合格」。 */
    readonly attempts: string;
    readonly calls: number;
    readonly usd: number;
    /** 最後の試行が落ちたときの指摘。 */
    readonly lastProblems?: { readonly stage: string; readonly problems: readonly string[] };
}

export function facts(job: Job): JobFacts {
    const plan = job.plan;
    const last = job.attempts.at(-1)?.result;
    return {
        title: plan?.title,
        pitch: plan?.pitch,
        subject: plan?.subject,
        form: formOf(job.form).label,
        twist: plan?.twist?.length ? plan.twist.map(t => `${t.axis}=${t.option}`).join(" / ") : undefined,
        author: job.persona?.penName,
        model: job.model,
        attempts: job.attempts.length
            ? job.attempts.map(a => `${a.n}: ${!a.result ? "検査前" : a.result.ok ? "合格" : `${a.result.stage} 不合格`}`).join(" → ")
            : "生成まで進まなかった",
        calls: job.calls.length,
        usd: job.calls.reduce((n, c) => n + c.usd, 0),
        ...(last && !last.ok ? { lastProblems: { stage: last.stage, problems: last.problems } } : {})
    };
}

const STATE: Record<string, string> = {
    accepted: "採用",
    rejected: "不採用",
    planning: "中断（企画）",
    generating: "中断（生成）",
    checking: "中断（検査）"
};

/**
 * ログに書く一塊。一行目だけ見れば結果が分かるようにする。
 * 採用作の題は生成のときに付け直されることがあるので、分かっていれば work に渡す。
 */
export function summary(job: Job, work?: string): string {
    const f = facts(job);
    const title = work ?? f.title;
    const lines = [`■ ${STATE[job.state] ?? job.state} ${job.id}${title ? `「${title}」` : ""}`];
    const row = (label: string, value: string | undefined) => {
        if (value) lines.push(`    ${label.padEnd(4, "　")} ${value}`);
    };
    if (job.state === "rejected") row("理由", job.rejectReason ?? "不明");
    row("型", f.twist ? `${f.form}（縛り: ${f.twist}）` : f.form);
    row("作り手", [f.author, f.model].filter(Boolean).join(" / "));
    row("企画", f.title && f.title !== title ? `「${f.title}」 ${f.pitch}` : f.pitch);
    row("試行", f.attempts);
    row("費用", `$${f.usd.toFixed(4)}（AI 呼出し ${f.calls} 回）`);
    return lines.join("\n");
}
