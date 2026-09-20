// いまどうなっているかを一目で。`fanm status` の中身。
//
// 人が読むためのものであり、コンテナの健康診断（HEALTHCHECK）でもある。
// 常駐が動いていて、目印が新しく、人を呼んでいなければ健康とする。

import { join } from "node:path";
import { Archive } from "../archive/archive.js";
import { Ledger } from "../budget/ledger.js";
import type { Config } from "../config.js";
import { JobStore } from "../jobs/job.js";
import { UNKNOWN_COST_RATIO } from "../scheduler/scheduler.js";
import { isRunning } from "./lock.js";
import { readState } from "./state.js";

/** これより古い目印は、止まっているか固まっているとみなす。 */
const STALE_MS = 3 * 60_000;

const PHASE: Record<string, string> = {
    waiting: "次の制作を待っている",
    paused: "休んでいる",
    making: "作っている",
    publishing: "公開している",
    failing: "失敗して間を置いている"
};

function ago(at: string | undefined): string {
    if (!at) return "まだない";
    const ms = Date.now() - Date.parse(at);
    if (ms < 60_000) return `${Math.round(ms / 1000)}秒前`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}分前`;
    return `${(ms / 3_600_000).toFixed(1)}時間前`;
}

function until(at: string | undefined): string {
    if (!at) return "未定";
    const ms = Date.parse(at) - Date.now();
    if (ms <= 0) return "まもなく";
    if (ms < 3_600_000) return `あと${Math.round(ms / 60_000)}分`;
    return `あと${(ms / 3_600_000).toFixed(1)}時間`;
}

export function status(root: string, config: Config): { text: string; healthy: boolean } {
    const state = readState(root);
    const running = isRunning(root);
    const fresh = state.beat ? Date.now() - Date.parse(state.beat.at) < STALE_MS : false;
    const ledger = new Ledger(join(root, "ledger"), config.budget);
    const archive = new Archive(join(root, "works"));
    const works = archive.ids();
    const sent = new Set(state.published);
    const unfinished = new JobStore(join(root, "jobs")).unfinished();
    const cost = ledger.costPerJob() ?? config.budget.perWorkUsd * UNKNOWN_COST_RATIO;

    const lines = [
        running
            ? `常駐: 動いている（pid ${running.pid}、${ago(running.since)}から）`
            : "常駐: 動いていない（fanm run で始める）",
        `  いま: ${PHASE[state.beat?.phase ?? ""] ?? state.beat?.phase ?? "不明"}（目印は${ago(state.beat?.at)}${running && !fresh ? "、古い" : ""}）`,
        `  次の制作: ${state.beat?.next ?? "未定"}（${until(state.beat?.next)}）`,
        `  今月: $${ledger.spentThisMonth().toFixed(4)} / $${config.budget.monthlyUsd}（一作品あたり $${cost.toFixed(4)}）`,
        `  作品: ${works.length} 件（未公開 ${works.filter(id => !sent.has(id)).length} 件）、最後の公開は${ago(state.lastPublishAt)}`,
        `  途中のジョブ: ${unfinished.length ? unfinished.map(j => `${j.id}(${j.state})`).join(", ") : "なし"}`
    ];
    if (state.attention) lines.push(`  人の対応が必要: ${state.attention.message}（${ago(state.attention.at)}）`);

    return { text: lines.join("\n"), healthy: Boolean(running) && fresh && !state.attention };
}
