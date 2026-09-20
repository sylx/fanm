// 制作ジョブ。一作品の試行を一つのジョブとし、<VAR>/jobs/<id>/ に保存する。
// 状態を変えるたびに書き出すので、コンテナやホストが止まっても続きから再開できる。
//
//     planning → generating ⇄ checking → accepted | rejected
//
// <VAR>/jobs/<id>/
//     job.json            このファイルの Job
//     attempt-1/          生成1回目: response.md（AIの応答そのまま）, work.ts, meta.json, report.json, check/
//     attempt-2/          修正1回目 ...

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallLog } from "../providers/call.js";
import type { Plan } from "../plan/planner.js";

export type JobState = "planning" | "generating" | "checking" | "accepted" | "rejected";

export interface Attempt {
    readonly n: number;
    /** 検査を終えたら入る。 */
    result?: { ok: boolean; stage: string; problems: readonly string[] };
}

export interface Job {
    readonly id: string;
    readonly createdAt: string;
    updatedAt: string;
    state: JobState;
    readonly seed: number;
    /** 作品の型。企画の前に決まり、やり直しても変わらない。 */
    form?: string;
    /** 頼む相手のモデル名。型と同じく企画の前に引き、やり直しても変わらない。 */
    model?: string;
    plan?: Plan;
    attempts: Attempt[];
    calls: CallLog[];
    /** 本文が空で返った回数。思考だけで出力上限に達したとき。 */
    emptyResponses?: number;
    rejectReason?: string;
}

export class JobStore {
    constructor(readonly dir: string) {
        mkdirSync(dir, { recursive: true });
    }

    create(): Job {
        const now = new Date();
        const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
        const job: Job = {
            id: `${stamp}-${Math.random().toString(36).slice(2, 6)}`,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            state: "planning",
            seed: Math.floor(Math.random() * 2 ** 31),
            attempts: [],
            calls: []
        };
        mkdirSync(this.jobDir(job.id), { recursive: true });
        this.save(job);
        return job;
    }

    jobDir(id: string): string {
        return join(this.dir, id);
    }

    attemptDir(job: Job, n: number): string {
        return join(this.jobDir(job.id), `attempt-${n}`);
    }

    save(job: Job): void {
        job.updatedAt = new Date().toISOString();
        const path = join(this.jobDir(job.id), "job.json");
        writeFileSync(`${path}.tmp`, JSON.stringify(job, null, 2));
        renameSync(`${path}.tmp`, path);
    }

    load(id: string): Job {
        return JSON.parse(readFileSync(join(this.jobDir(id), "job.json"), "utf8")) as Job;
    }

    /** 終わっていないジョブ。古い順。 */
    unfinished(): Job[] {
        return readdirSync(this.dir)
            .filter(id => existsSync(join(this.jobDir(id), "job.json")))
            .sort()
            .map(id => this.load(id))
            .filter(job => job.state !== "accepted" && job.state !== "rejected");
    }
}
