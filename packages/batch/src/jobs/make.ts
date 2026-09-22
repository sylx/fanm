// 一つのジョブを、保存された状態から最後まで進める。
//
//     企画 → 生成 → 検査 → (修正 → 検査)×最大 maxRepairs → 採用 | 不採用
//
// どの段階で止まっても、次に呼べば続きから進む。作品単位の予算を超えたら
// 不採用。月の予算を超えたら BudgetExceeded をそのまま投げ、ジョブは残す。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRandom } from "@fanm/work";
import type { Archive } from "../archive/archive.js";
import { BudgetExceeded, type Ledger } from "../budget/ledger.js";
import { checkWork, type CheckReport } from "../check/check.js";
import type { Config, ProviderConfig } from "../config.js";
import { FormatError, generateRequest, parseFiles, type PastAttempt } from "../generate/generator.js";
import { formOf, pickForm } from "../plan/forms.js";
import { penName } from "../persona/pen-name.js";
import { drawTraits, personaBrief } from "../persona/persona.js";
import { parsePlan, planRequest } from "../plan/planner.js";
import { drawTwist } from "../plan/variations.js";
import { template } from "../prompts.js";
import { call } from "../providers/call.js";
import { createProvider, drawProvider } from "../providers/deck.js";
import type { OnDelta, Provider } from "../providers/provider.js";
import type { Log } from "../run/log.js";
import type { Job, JobStore } from "./job.js";

export interface MakeContext {
    readonly config: Config;
    /** 頼む相手の札束。ジョブごとにここから一人引く。 */
    readonly deck: readonly ProviderConfig[];
    readonly ledger: Ledger;
    readonly jobs: JobStore;
    readonly archive: Archive;
    readonly log: Log;
}

/** 相手が決まったあとの場。この先は一人の相手と、その相手の予算枠で進む。 */
interface Making extends MakeContext {
    readonly provider: Provider;
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

/**
 * 今回頼む相手。型や縛りと同じく、企画の前に引いてジョブに残す。落ちて再開しても
 * 同じ相手になる。札束から消えた相手が残っていたら引き直す（設定を変えたとき）。
 */
function draw(ctx: MakeContext, job: Job): ProviderConfig {
    const kept = ctx.deck.find(e => e.model === job.model);
    if (kept) {
        // 性格を持たせる前に企画まで進んでいたジョブには、途中から着せない。
        if (!job.persona && !job.plan) cast(ctx, job, kept);
        return kept;
    }
    const entry = drawProvider(ctx.deck, ctx.archive.models(), createRandom(job.seed ^ 0xdec4));
    job.model = entry.model;
    ctx.log.line(`${job.id}: 頼む相手は ${entry.name} の ${entry.model}`);
    // 名前はモデルごとなので、相手を引き直したら作り手も引き直す。
    cast(ctx, job, entry);
    return entry;
}

/**
 * 作り手を決めてジョブに残す。persona.reuse（札に reuse があればそちら）の割合で、
 * この相手の過去の作り手を呼び戻す。それ以外は性格を引き、名前を付ける。どちらもジョブの種から引くので、
 * 落ちて再開しても同じ作り手になる。相手を引き直したときは、その相手の作り手で
 * 決め直す（名前はモデルごとのため）。
 */
function cast(ctx: MakeContext, job: Job, entry: ProviderConfig): void {
    const known = ctx.archive.authors();
    const random = createRandom(job.seed ^ 0x2e05);
    const regulars = [...new Map(known.filter(a => a.model === entry.model).map(a => [a.penName, a])).values()];
    const reuse = entry.reuse ?? ctx.config.persona.reuse;
    const returning = regulars.length > 0 && random() < reuse
        ? regulars[Math.floor(random() * regulars.length)]
        : undefined;
    const traits = returning?.traits ?? drawTraits(createRandom(job.seed ^ 0x9e75));
    const persona = { penName: returning?.penName ?? penName(entry.name, entry.model, traits, known), traits };
    job.persona = persona;
    ctx.jobs.save(job);
    ctx.log.line(`${job.id}: 作り手は ${personaBrief(persona)}${returning ? "（再登場）" : ""}`);
}

export async function make(base: MakeContext, job: Job): Promise<Job> {
    const entry = draw(base, job);
    // 一作品にいくらまで使うかは相手ごとに変えられる。単価が違う相手を同じ枠では測れない。
    const ledger = entry.perWorkUsd === undefined ? base.ledger : base.ledger.withPerWork(entry.perWorkUsd);
    const ctx: Making = { ...base, ledger, provider: createProvider(entry) };
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

async function plan(ctx: Making, job: Job): Promise<void> {
    const past = ctx.archive.plans();
    // 型はAIに選ばせない。過去作に少ない型を当てる。同じジョブなら毎回同じ型。
    const form = job.form ? formOf(job.form) : pickForm(past, createRandom(job.seed));
    job.form = form.id;
    // 縛りも引く。型が同じでも段取りが前と変わるように。ジョブの種から引くので、
    // 企画をやり直しても同じ縛りになる。
    const twist = drawTwist(form.id, past, createRandom(job.seed ^ 0x7c157));
    ctx.log.line(`${job.id}: 型は${form.label}、縛りは ${twist.map(t => `${t.axis}=${t.option}`).join(" / ")}`);
    const result = await call(ctx.provider, ctx.ledger, job.id, "plan",
        planRequest(past, form, twist, job.persona, ctx.config.generation.planMaxTokens), deltas(ctx.log));
    job.calls.push(result.log);
    try {
        job.plan = parsePlan(result.text, form, twist);
    } catch (e) {
        // 企画の JSON が壊れているなら、次のループでもう一度企画させる。3回までで諦める。
        ctx.log.line(`${job.id}: 企画を読めない（${(e as Error).message}）`);
        if (job.calls.filter(c => c.purpose === "plan").length >= 3) reject(ctx, job, "企画を3回読めなかった");
        return;
    }
    ctx.log.line(`${job.id}: 企画「${job.plan.title}」（${form.label}） ${job.plan.pitch}`);
    job.state = "generating";
}

/**
 * 検査を終えた試行を、修正の会話に渡す形で読み出す。応答が空のものは飛ばす。
 * 空の発言を会話に混ぜても、AIには直しようがないため。
 */
function pastAttempts(ctx: Making, job: Job): PastAttempt[] {
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

async function generate(ctx: Making, job: Job): Promise<void> {
    const n = job.attempts.length + 1;
    const { generation } = ctx.config;
    // 前回、思考だけで出力上限に達していたら、思考を切って頼み直す。
    const thinkingRanAway = (job.emptyResponses ?? 0) > 0;
    const request = generateRequest(job.plan!, job.persona, pastAttempts(ctx, job), {
        maxOutputTokens: generation.generateMaxTokens,
        reasoningEffort: thinkingRanAway ? "none" : generation.reasoningEffort
    });
    const result = await call(ctx.provider, ctx.ledger, job.id, n === 1 ? "generate" : `repair-${n - 1}`, request, deltas(ctx.log));
    job.calls.push(result.log);
    ctx.log.line(`思考 ${result.log.reasoningTokens} / 本文 ${result.log.outputTokens - result.log.reasoningTokens} トークン、$${result.log.usd.toFixed(4)}`);

    // 思考だけで出力上限に達すると本文が空で返る。会話に空の発言を残さず、やり直す。
    if (!result.text.trim()) {
        job.emptyResponses = (job.emptyResponses ?? 0) + 1;
        ctx.log.line(`${job.id}: 本文が空で返った（${job.emptyResponses}回目）`);
        if (job.emptyResponses >= 3) reject(ctx, job, "本文が空の応答が続いた。思考の量か出力上限を見直す");
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

async function check(ctx: Making, job: Job): Promise<void> {
    const attempt = job.attempts[job.attempts.length - 1];
    const dir = ctx.jobs.attemptDir(job, attempt.n);
    // 実例と、同じ型の過去作を見比べる相手に渡す。名前だけ変えた写しを採用しない。
    // 偽のAIは実例をそのまま返すので、そのときは見比べない。
    const form = formOf(job.form).id;
    const references = ctx.provider.name === "fake" ? [] : [
        { label: `実例（templates/${form}/work.ts）`, source: template(form) },
        ...ctx.archive.sources(form, 3)
    ];
    const report = await checkWork(dir, job.seed, { references, maxOverlap: ctx.config.generation.maxOverlap });
    writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
    finishAttempt(ctx, job, { ok: report.ok, stage: report.stage, problems: report.problems });

    if (report.ok) {
        const meta = ctx.archive.add(job, dir, report);
        job.state = "accepted";
        ctx.log.line(`${job.id}: 採用「${meta.title}」`);
    }
}

function finishAttempt(ctx: Making, job: Job, result: NonNullable<Job["attempts"][number]["result"]>): void {
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

function reject(ctx: Making, job: Job, reason: string): void {
    job.state = "rejected";
    job.rejectReason = reason;
    ctx.log.line(`${job.id}: 不採用 — ${reason}`);
}
