// 一つのジョブを、保存された状態から最後まで進める。
//
//     企画 → (描く →) 生成 → 検査 → (修正 → 検査)×最大 maxRepairs → 採用 | 不採用
//
// 描くのは D部門の作品だけ。D部門は型に掛け合わせる印で、型はいつもどおり選ぶ。
// 企画が頼んだ絵を描き手に描かせ、ジョブの images/ に置く。試行ごとにそれを写し、
// 作品に同梱して検査する。
//
// どの段階で止まっても、次に呼べば続きから進む。作品単位の予算を超えたら
// 不採用。月の予算を超えたら BudgetExceeded をそのまま投げ、ジョブは残す。

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRandom } from "@fanm/work";
import type { Archive } from "../archive/archive.js";
import { BudgetExceeded, type Ledger } from "../budget/ledger.js";
import { checkWork, type CheckReport } from "../check/check.js";
import { IMAGES_DIR } from "../check/images.js";
import type { Config, ProviderConfig } from "../config.js";
import { FormatError, generateRequest, parseFiles, type PastAttempt } from "../generate/generator.js";
import { picturesBrief } from "../paint/brief.js";
import { createPainter, paintPicture } from "../paint/paint.js";
import { activeForms, formOf, pickForm } from "../plan/forms.js";
import { departmentOf, type Department } from "../plan/season.js";
import { penName } from "../persona/pen-name.js";
import { drawTraits, personaBrief } from "../persona/persona.js";
import { parsePlan, planRequest } from "../plan/planner.js";
import { drawTwist } from "../plan/variations.js";
import { template } from "../prompts.js";
import { call } from "../providers/call.js";
import { createProvider, drawProvider, rest, rested } from "../providers/deck.js";
import { ProviderError, type OnDelta, type Provider } from "../providers/provider.js";
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
    // 枠が尽きて休んでいる相手は引かない。全員が休んでいるなら、そのまま頼んで断られる
    // （相手を名指しされたときなど。断られたことは呼んだ側が記録する）。
    const available = rested(ctx.deck);
    const deck = available.length ? available : ctx.deck;
    const kept = deck.find(e => e.model === job.model);
    if (kept) {
        // 性格を持たせる前に企画まで進んでいたジョブには、途中から着せない。
        if (!job.persona && !job.plan) cast(ctx, job, kept);
        return kept;
    }
    const entry = drawProvider(deck, ctx.archive.models(), createRandom(job.seed ^ 0xdec4));
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
            else if (job.state === "painting") await paint(ctx, job);
            else if (job.state === "generating") await generate(ctx, job);
            else await check(ctx, job);
            ctx.jobs.save(job);
        }
    } catch (e) {
        if (e instanceof BudgetExceeded && e.scope === "work") {
            reject(ctx, job, `作品予算を超えた: ${e.message}`);
            ctx.jobs.save(job);
        } else if (e instanceof ProviderError && e.kind === "limit") {
            // 定額の枠が尽きた。この相手を戻る時刻まで休ませ、続きを別の相手に書かせる。
            // 企画まで済んでいれば、企画はそのまま使う。ほかに誰もいなければ、ジョブを
            // 残して呼んだ側へ返す（次の回に、戻っていればこの相手が、いなければ別の相手が続ける）。
            const until = e.until ?? new Date(Date.now() + 3 * 3600_000);
            rest(entry.model, until);
            ctx.log.line(`${job.id}: ${entry.model} の枠が尽きた。${until.toISOString()} まで休ませる（${e.message}）`);
            if (!rested(base.deck).length) throw e;
            job.model = undefined;
            ctx.jobs.save(job);
            return make(base, job);
        } else {
            throw e;
        }
    }
    return job;
}

async function plan(ctx: Making, job: Job): Promise<void> {
    // 直近120作。詳しく見せるのは近い24作だけで、残りは題と題材（planner.ts の pastBrief）。
    const past = ctx.archive.plans(120);
    // 部門が先。D部門に当たったら、絵を置けない型を除いて選ぶ。
    const outside = department(ctx, job);
    job.department = outside?.id;
    // 型はAIに選ばせない。過去作に少ない型を当てる。同じジョブなら毎回同じ型。
    const choices = outside ? activeForms().filter(f => !outside.skipForms.includes(f.id)) : activeForms();
    const form = job.form ? formOf(job.form) : pickForm(past, createRandom(job.seed), choices);
    job.form = form.id;
    // 縛りも引く。型が同じでも段取りが前と変わるように。ジョブの種から引くので、
    // 企画をやり直しても同じ縛りになる。
    const twist = drawTwist(form.id, past, createRandom(job.seed ^ 0x7c157), job.department);
    const kind = outside ? `${form.label}・${outside.label}` : form.label;
    ctx.log.line(`${job.id}: 型は${kind}、縛りは ${twist.map(t => `${t.axis}=${t.option}`).join(" / ")}`);
    ctx.log.line(`${job.id}: 企画を ${ctx.provider.model} に頼む`);
    const result = await call(ctx.provider, ctx.ledger, job.id, "plan",
        planRequest(past, form, twist, job.persona, job.department, ctx.config.generation.planMaxTokens), deltas(ctx.log));
    job.calls.push(result.log);
    try {
        job.plan = parsePlan(result.text, form, twist, job.department);
    } catch (e) {
        // 企画の JSON が壊れているなら、次のループでもう一度企画させる。3回までで諦める。
        ctx.log.line(`${job.id}: 企画を読めない（${(e as Error).message}）`);
        if (job.calls.filter(c => c.purpose === "plan").length >= 3) reject(ctx, job, "企画を3回読めなかった");
        return;
    }
    ctx.log.line(`${job.id}: 企画「${job.plan.title}」（${kind}） ${job.plan.pitch}`);
    job.state = job.plan.pictures?.length ? "painting" : "generating";
}

/**
 * 部門に当てるか。指定（--department）されていればそれ。無ければ設定の割合
 * （departments.d.share）で、ジョブの種から引く。同じジョブは何度やり直しても
 * 同じ答えになる。型が先に決まっていて（--form）、その型と組めないなら当てない。
 */
function department(ctx: Making, job: Job): Department | undefined {
    if (job.department) return departmentOf(job.department);
    const { share, painters } = ctx.config.departments.d;
    // 偽のAIは絵を頼む企画を書けない。
    if (!(share > 0) || !painters.length || ctx.provider.name === "fake") return undefined;
    if (createRandom(job.seed ^ 0xd0d0)() >= share) return undefined;
    const d = departmentOf("d");
    if (!d || (job.form && d.skipForms.includes(job.form))) return undefined;
    ctx.log.line(`${job.id}: ${d.label}に当たった`);
    return d;
}

/**
 * 企画が頼んだ絵を描かせ、ジョブの images/ に置く。描き終えた絵は描き直さない
 * （途中で落ちて再開したら、残りだけ描く）。
 *
 * 描けなかったら不採用にする。描き手の枠切れ（limit）もここで受ける。外へ投げると、
 * 書く相手の枠が尽きたと取り違えて、書く相手を休ませてしまう。人が直すしかない
 * 失敗（認証切れなど）だけは外へ投げ、知らせてもらう。
 */
async function paint(ctx: Making, job: Job): Promise<void> {
    const painter = createPainter(ctx.config.departments.d.painters[0]);
    const dir = ctx.jobs.jobDir(job.id);
    for (const picture of job.plan!.pictures ?? []) {
        if (existsSync(join(dir, IMAGES_DIR, `${picture.name}.png`))) continue;
        ctx.log.line(`${job.id}: 絵「${picture.name}」を ${painter.name}（${painter.model}）に描かせる: ${picture.prompt}`);
        try {
            const painted = await paintPicture(painter, ctx.ledger, job.id, picture, dir);
            job.calls.push(painted.log);
            ctx.jobs.save(job);
            ctx.log.line(`${job.id}: 絵「${picture.name}」を描いた（${painted.seconds.toFixed(0)}秒、${painted.source.width}x${painted.source.height} → ${painted.width}x${painted.height}）`);
        } catch (e) {
            if (e instanceof ProviderError && e.fatal) throw e;
            if (e instanceof BudgetExceeded) throw e;
            reject(ctx, job, `絵「${picture.name}」を描けなかった: ${(e as Error).message}`);
            return;
        }
    }
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
    }, picturesBrief(job.plan!.pictures, ctx.jobs.jobDir(job.id)));
    ctx.log.line(`${job.id}: 試行${n} の${n === 1 ? "生成" : "修正"}を ${ctx.provider.model} に頼む${thinkingRanAway ? "（思考なし）" : ""}`);
    const result = await call(ctx.provider, ctx.ledger, job.id, n === 1 ? "generate" : `repair-${n - 1}`, request, deltas(ctx.log));
    job.calls.push(result.log);
    ctx.log.line(`${job.id}: 試行${n} の応答 — 思考 ${result.log.reasoningTokens} / 本文 ${result.log.outputTokens - result.log.reasoningTokens} トークン、$${result.log.usd.toFixed(4)}`);

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
        // 描いた絵を試行に写す。検査も作品庫も、作品のディレクトリの images/ を読む。
        const images = join(ctx.jobs.jobDir(job.id), IMAGES_DIR);
        if (existsSync(images)) cpSync(images, join(dir, IMAGES_DIR), { recursive: true });
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
    ctx.log.line(`${job.id}: 試行${attempt.n} を検査する`);
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
