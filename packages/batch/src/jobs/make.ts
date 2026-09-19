// 一つのジョブを、保存された状態から最後まで進める。
//
//     企画 → 生成 → 検査 → (修正 → 検査)×最大 maxRepairs → 採用 | 不採用
//
// どの段階で止まっても、次に呼べば続きから進む。作品単位の予算を超えたら
// 不採用。月の予算を超えたら BudgetExceeded をそのまま投げ、ジョブは残す。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Archive } from "../archive/archive.js";
import { BudgetExceeded, type Ledger } from "../budget/ledger.js";
import { checkWork, type CheckReport } from "../check/check.js";
import type { Config } from "../config.js";
import { FormatError, generateRequest, parseFiles, type PastAttempt } from "../generate/generator.js";
import { parsePlan, planRequest } from "../plan/planner.js";
import { call } from "../providers/call.js";
import type { OnDelta, Provider } from "../providers/provider.js";
import type { Log } from "../run/log.js";
import type { Job, JobStore } from "./job.js";

export interface MakeContext {
    readonly config: Config;
    readonly provider: Provider;
    readonly ledger: Ledger;
    readonly jobs: JobStore;
    readonly archive: Archive;
    readonly log: Log;
}

/** 思考と本文を、届いた端からログへ流す。待っている人に何をしているか見せるため。 */
function deltas(log: Log): OnDelta {
    let kind: string | null = null;
    return (next, text) => {
        if (next !== kind) {
            log.stream(`\n--- ${next === "reasoning" ? "思考" : "応答"} ---\n`);
            kind = next;
        }
        log.stream(text);
    };
}

export async function make(ctx: MakeContext, job: Job): Promise<Job> {
    try {
        while (job.state !== "accepted" && job.state !== "rejected") {
            if (job.state === "planning") await plan(ctx, job);
            else if (job.state === "generating") await generate(ctx, job);
            else await check(ctx, job);
            ctx.jobs.save(job);
        }
    } catch (e) {
        if (e instanceof BudgetExceeded && e.scope === "work") {
            reject(ctx, job, `作品予算を超えた: ${e.message}`);
            ctx.jobs.save(job);
        } else {
            throw e;
        }
    }
    return job;
}

async function plan(ctx: MakeContext, job: Job): Promise<void> {
    const past = ctx.archive.plans();
    const result = await call(ctx.provider, ctx.ledger, job.id, "plan",
        planRequest(past, ctx.config.generation.planMaxTokens), deltas(ctx.log));
    job.calls.push(result.log);
    try {
        job.plan = parsePlan(result.text);
    } catch (e) {
        // 企画の JSON が壊れているなら、次のループでもう一度企画させる。3回までで諦める。
        ctx.log.line(`${job.id}: 企画を読めない（${(e as Error).message}）`);
        if (job.calls.filter(c => c.purpose === "plan").length >= 3) reject(ctx, job, "企画を3回読めなかった");
        return;
    }
    ctx.log.line(`${job.id}: 企画「${job.plan.title}」 ${job.plan.pitch}`);
    job.state = "generating";
}

/**
 * 検査を終えた試行を、修正の会話に渡す形で読み出す。応答が空のものは飛ばす。
 * 空の発言を会話に混ぜても、AIには直しようがないため。
 */
function pastAttempts(ctx: MakeContext, job: Job): PastAttempt[] {
    return job.attempts.filter(a => a.result).map(a => {
        const dir = ctx.jobs.attemptDir(job, a.n);
        const reportPath = join(dir, "report.json");
        const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) as CheckReport : undefined;
        return {
            response: readFileSync(join(dir, "response.md"), "utf8"),
            stage: a.result!.stage,
            problems: a.result!.problems,
            observations: report?.observations ?? ""
        };
    }).filter(a => a.response.trim());
}

async function generate(ctx: MakeContext, job: Job): Promise<void> {
    const n = job.attempts.length + 1;
    const { generation } = ctx.config;
    const request = generateRequest(job.plan!, pastAttempts(ctx, job), {
        maxOutputTokens: generation.generateMaxTokens,
        reasoningEffort: generation.reasoningEffort
    });
    const result = await call(ctx.provider, ctx.ledger, job.id, n === 1 ? "generate" : `repair-${n - 1}`, request, deltas(ctx.log));
    job.calls.push(result.log);
    ctx.log.line(`思考 ${result.log.reasoningTokens} / 本文 ${result.log.outputTokens - result.log.reasoningTokens} トークン、$${result.log.usd.toFixed(4)}`);

    // 思考だけで出力上限に達すると本文が空で返る。会話に空の発言を残さず、やり直す。
    if (!result.text.trim()) {
        job.emptyResponses = (job.emptyResponses ?? 0) + 1;
        ctx.log.line(`${job.id}: 本文が空で返った（${job.emptyResponses}回目）`);
        if (job.emptyResponses >= 2) reject(ctx, job, "本文が空の応答が続いた。思考の量か出力上限を見直す");
        return;
    }

    const dir = ctx.jobs.attemptDir(job, n);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "response.md"), result.text);
    job.attempts.push({ n });

    try {
        const files = parseFiles(result.text, result.truncated);
        writeFileSync(join(dir, "work.ts"), files.work);
        writeFileSync(join(dir, "meta.json"), JSON.stringify(files.meta, null, 2));
        job.state = "checking";
        ctx.log.line(`${job.id}: 試行${n} を生成`);
    } catch (e) {
        if (!(e instanceof FormatError)) throw e;
        finishAttempt(ctx, job, { ok: false, stage: "format", problems: e.problems });
    }
}

async function check(ctx: MakeContext, job: Job): Promise<void> {
    const attempt = job.attempts[job.attempts.length - 1];
    const dir = ctx.jobs.attemptDir(job, attempt.n);
    const report = await checkWork(dir, job.seed);
    writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
    finishAttempt(ctx, job, { ok: report.ok, stage: report.stage, problems: report.problems });

    if (report.ok) {
        const meta = ctx.archive.add(job, dir, report);
        job.state = "accepted";
        ctx.log.line(`${job.id}: 採用「${meta.title}」`);
    }
}

function finishAttempt(ctx: MakeContext, job: Job, result: NonNullable<Job["attempts"][number]["result"]>): void {
    const attempt = job.attempts[job.attempts.length - 1];
    attempt.result = result;
    if (result.ok) return;
    ctx.log.line(`${job.id}: 試行${attempt.n} 不合格（${result.stage}）\n  ${result.problems.join("\n  ").slice(0, 600)}`);
    if (job.attempts.length > ctx.config.production.maxRepairs) {
        reject(ctx, job, `修正${ctx.config.production.maxRepairs}回で直らなかった（最後は ${result.stage}）`);
    } else {
        job.state = "generating";
    }
}

function reject(ctx: MakeContext, job: Job, reason: string): void {
    job.state = "rejected";
    job.rejectReason = reason;
    ctx.log.line(`${job.id}: 不採用 — ${reason}`);
}
