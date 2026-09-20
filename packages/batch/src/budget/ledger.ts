// 予算台帳。すべてのAPI呼出しは、呼ぶ前に最大想定費用を予約し、
// 終わってから実際の利用量で精算する。
//
// 台帳は月ごとに <VAR>/ledger/YYYY-MM.json へ書く。書くたびに一時ファイル
// から置き換えるので、途中で落ちても壊れた台帳は残らない。予約したまま
// 落ちた呼出しは、次に読んだときも予約額のまま数える。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Entry {
    readonly id: string;
    readonly jobId: string;
    readonly purpose: string;
    readonly at: string;
    readonly maxUsd: number;
    /** reserved: 精算前。settled: 実額で確定。unknown: 請求の有無が分からず予約額で確定。 */
    status: "reserved" | "settled" | "unknown";
    usd?: number;
    tokens?: { input: number; cached: number; output: number; reasoning: number };
}

export interface Limits {
    readonly monthlyUsd: number;
    readonly perWorkUsd: number;
}

export class BudgetExceeded extends Error {
    constructor(message: string, readonly scope: "month" | "work") {
        super(message);
    }
}

const month = (at: Date) => at.toISOString().slice(0, 7);

/**
 * 確定額。走っている最中のものは予約額で数える（使い過ぎを防ぐため高く見る）。
 * 中断して確定したものは、途中まで届いた分の見積りがあればそれで数える。
 */
const cost = (entry: Entry) => entry.status === "reserved" ? entry.maxUsd : entry.usd ?? entry.maxUsd;

export class Ledger {
    constructor(private readonly dir: string, private readonly limits: Limits) {
        mkdirSync(dir, { recursive: true });
    }

    private path(at = new Date()): string {
        return join(this.dir, `${month(at)}.json`);
    }

    private read(path = this.path()): Entry[] {
        return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Entry[] : [];
    }

    private write(entries: Entry[], path = this.path()): void {
        writeFileSync(`${path}.tmp`, JSON.stringify(entries, null, 2));
        renameSync(`${path}.tmp`, path);
    }

    spentThisMonth(): number {
        return this.read().reduce((n, e) => n + cost(e), 0);
    }

    /** ジョブの費用。月をまたいだジョブもあるので前月の台帳も見る。 */
    spentOnJob(jobId: string): number {
        const now = new Date();
        const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        return [this.path(last), this.path(now)]
            .flatMap(p => this.read(p))
            .filter(e => e.jobId === jobId)
            .reduce((n, e) => n + cost(e), 0);
    }

    /** 今月あといくら使えるか。制作の頻度を決めるのに使う。 */
    remainingThisMonth(): number {
        return this.limits.monthlyUsd - this.spentThisMonth();
    }

    /**
     * 最近のジョブ一件あたりの費用（実測）。まだ履歴がなければ undefined。
     * 単価表ではなく、これで頻度を決める。修正や不採用の分も入った実費なので、
     * 「公開できた一作品あたり」に近い数字になる。
     */
    costPerJob(limit = 8): number | undefined {
        const now = new Date();
        const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        const byJob = new Map<string, number>();
        for (const entry of [...this.read(this.path(previous)), ...this.read(this.path(now))]) {
            byJob.set(entry.jobId, (byJob.get(entry.jobId) ?? 0) + cost(entry));
        }
        const recent = [...byJob.values()].slice(-limit);
        return recent.length ? recent.reduce((n, usd) => n + usd, 0) / recent.length : undefined;
    }

    /** 上限を超えるなら BudgetExceeded を投げ、呼出しをさせない。 */
    reserve(jobId: string, purpose: string, maxUsd: number): Entry {
        const entries = this.read();
        const month = entries.reduce((n, e) => n + cost(e), 0);
        if (month + maxUsd > this.limits.monthlyUsd) {
            throw new BudgetExceeded(`月間予算: 使用 $${month.toFixed(4)} + 予約 $${maxUsd.toFixed(4)} > $${this.limits.monthlyUsd}`, "month");
        }
        const job = this.spentOnJob(jobId);
        if (job + maxUsd > this.limits.perWorkUsd) {
            throw new BudgetExceeded(`作品予算: 使用 $${job.toFixed(4)} + 予約 $${maxUsd.toFixed(4)} > $${this.limits.perWorkUsd}`, "work");
        }
        const entry: Entry = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            jobId, purpose, at: new Date().toISOString(), maxUsd, status: "reserved"
        };
        entries.push(entry);
        this.write(entries);
        return entry;
    }

    /** 走っている最中の見積り。中断されたとき、これが確定額になる。 */
    progress(entry: Entry, usd: number): void {
        this.update(entry, e => { if (e.status === "reserved") e.usd = usd; });
    }

    /**
     * 予約のまま残っているものを確定する。途中経過があればその額、
     * なければ予約額。前回の異常終了の後始末で、
     * 鍵を取ってから（ほかに動いているプロセスがないと分かってから）呼ぶ。
     */
    sweepReserved(): number {
        const entries = this.read();
        const stale = entries.filter(e => e.status === "reserved");
        if (!stale.length) return 0;
        for (const entry of stale) entry.status = "unknown";     // usd は progress が入れた見積りのまま
        this.write(entries);
        return stale.length;
    }

    settle(entry: Entry, usd: number, tokens?: Entry["tokens"]): void {
        this.update(entry, e => { e.status = "settled"; e.usd = usd; e.tokens = tokens; });
    }

    /** 請求されたか分からない失敗。予約額で確定する。 */
    settleUnknown(entry: Entry): void {
        this.update(entry, e => { e.status = "unknown"; });
    }

    private update(entry: Entry, change: (e: Entry) => void): void {
        const path = this.path(new Date(entry.at));
        const entries = this.read(path);
        const found = entries.find(e => e.id === entry.id);
        if (!found) throw new Error(`台帳に ${entry.id} がない`);
        change(found);
        this.write(entries, path);
    }
}
