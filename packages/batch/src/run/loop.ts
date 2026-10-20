// 制作を回し続ける常駐部。`fanm run` の中身。
//
//     待つ → 一作品つくる → 公開する → 待つ …
//
// 30秒ごとに目を覚まし、そのたびに「いま作ってよいか」をスケジューラーに訊く。
// 頻度は残予算と実測の費用から決まる（scheduler.ts）。次まで待てないときは横から
// 頼める（request.ts）。頼まれた回は間隔を飛ばす。採用作が出来たらその場で公開する。
//
// 止まらないことを第一にする。日常の失敗（不採用、一時的な通信断）は記録して次へ進み、
// 放っておいても直らないもの（鍵切れ、権限不足、続けざまの想定外）だけ人を呼ぶ。
// 不採用は人を呼ばないが、企画と理由を便りとして送る（何が落ちているかを見えるように）。
//
// ログ（コンテナのログ）には、一作品ごとに「■ 採用 / 不採用」のまとめと、
// 公開した作品の題とURL、次の制作の予定が出る。予定は変わったときだけ書く。
// 途中で殺されても、ジョブと台帳と覚え書きは書かれた時点まで残るので、続きから再開する。

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Archive } from "../archive/archive.js";
import { BudgetExceeded, Ledger } from "../budget/ledger.js";
import { changedSections, ConfigWatch, type Config, type ProviderConfig } from "../config.js";
import { JobStore, type Job } from "../jobs/job.js";
import { make } from "../jobs/make.js";
import { facts, summary } from "../jobs/summary.js";
import { deckBrief, deckNamed, verifyDeck } from "../providers/deck.js";
import { ProviderError } from "../providers/provider.js";
import { PublishError, type Publisher } from "../publish/publisher.js";
import { assemble } from "../publish/site.js";
import { decide, UNKNOWN_COST_RATIO, type SchedulerDecision } from "../scheduler/scheduler.js";
import { acquire } from "./lock.js";
import { takeRequest } from "./request.js";
import { clock, Log, logPath } from "./log.js";
import { COLOR, Notifier, type Embed } from "./notify.js";
import { StateStore, statePath } from "./state.js";

/** 目を覚ます間隔。短すぎても意味はないが、止まっていない証にはなる。 */
const TICK_MS = 30_000;
/** 公開に失敗したあと、次に送ってみるまで。 */
const PUBLISH_RETRY_MS = 30 * 60_000;
/** 想定外の失敗が続いたときに空ける時間。 */
const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];
/** 続けざまに何回失敗したら人を呼ぶか。 */
const CALL_HUMAN_AFTER = 3;
/**
 * 次の予定がこれ以上ずれたら書き直す。予定は残予算と残日数から毎回計算し直すので、
 * 端数だけなら30秒ごとに少しずつ動く。それをいちいち書くと、ログが予定で埋まる。
 */
const RESCHEDULE_NOTE_MS = 10 * 60_000;

export interface LoopOptions {
    readonly config: Config;
    /** 制作状態の置き場所。偽のAIなら <VAR>/fake/。 */
    readonly root: string;
    readonly fake: boolean;
    /** 札束をこれに固定する（--fake）。省くと設定の providers を使い、書き替えれば追う。 */
    readonly deck?: readonly ProviderConfig[];
    /** 送り先。undefined なら <VAR>/site/ を組み立てるだけで、どこへも送らない。 */
    readonly publisher?: Publisher;
    /** 一作品だけ作って終わる（動作確認用）。 */
    readonly once?: boolean;
    /** 今回だけ頼む相手を指す（makenow --provider）。事業者の名前かモデル名。 */
    readonly provider?: string;
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

/** いまから見て、いつか。 */
function fromNow(at: Date): string {
    const ms = at.getTime() - Date.now();
    if (ms <= 60_000) return "まもなく";
    if (ms < 3_600_000) return `あと${Math.round(ms / 60_000)}分`;
    return `あと${(ms / 3_600_000).toFixed(1)}時間`;
}

export async function runLoop(options: LoopOptions): Promise<number> {
    const { root } = options;
    // 設定は起動時に固めない。永続ボリュームの上で書き替えられたら、次に目を
    // 覚ましたときに読み直す（制作に入るのはそのあとなので、作るときの設定は必ず新しい）。
    let config = options.config;
    let deck = options.deck ?? config.providers;
    mkdirSync(root, { recursive: true });
    const lock = acquire(root);
    if (!lock.held) {
        console.error(`すでに動いている（pid ${lock.by.pid}、${lock.by.since} 開始）。二重には走らせない。`);
        return 1;
    }

    const log = new Log(logPath(root));
    const store = new StateStore(statePath(root));
    const notifier = new Notifier(store, log);
    let ledger = new Ledger(join(root, "ledger"), config.budget);
    const jobs = new JobStore(join(root, "jobs"));
    const archive = new Archive(join(root, "works"));

    const swept = ledger.sweepReserved();
    if (swept) log.line(`前回の中断で予約のまま残っていた ${swept} 件を、予約額のまま確定した`);
    verifyDeck(deck);
    log.line(`常駐を始める（${options.fake ? "偽のAI" : `札束は ${deckBrief(deck)}`}、状態は ${root}）`);

    const watch = new ConfigWatch();
    /**
     * 設定を読み直す。新しい札束を作れない（鍵が無い、単価表に無いモデル）なら、
     * 前の設定のまま続ける。動いているものを、書き間違いで止めない。
     */
    function refresh(): void {
        const next = watch.next(line => log.line(line));
        if (!next) return;
        const nextDeck = options.deck ?? next.providers;
        try {
            verifyDeck(nextDeck);
        } catch (e) {
            log.line(`新しい設定の札束を使えない。前のまま続ける: ${(e as Error).message}`);
            return;
        }
        const changed = changedSections(config, next);
        config = next;
        deck = nextDeck;
        ledger = new Ledger(join(root, "ledger"), config.budget);
        log.line(`設定を読み直した（${changed.join("、") || "中身は同じ"}）。札束は ${deckBrief(deck)}`);
        // 送り先だけは起動時に決まる（publisher を作り直さない）。貼るリンクは追う。
        if (changed.includes("publish")) log.line("公開の送り先を変えたなら、入れ替えないと効かない");
    }

    // 生きている目印は、制作の途中でも書き続ける。一作品つくるのに数分かかるので、
    // 輪が一周するのを待っていると、動いていても止まって見える。
    let phase = "starting";
    const setPhase = (next: string, at?: Date) => {
        phase = next;
        store.beat(next, at);
    };
    const beating = setInterval(() => store.beat(phase), TICK_MS);
    beating.unref();

    // 中断していたジョブがあれば、間隔を待たずに続きから片づける。
    let resume = jobs.unfinished().length > 0;
    if (resume) log.line("中断していたジョブがある。間隔を待たずに続きから進める");

    let nextPublishAt = 0;      // 公開に失敗したときだけ先へ延びる
    let failures = 0;
    /** 最後にログへ書いた予定。変わったときだけ書き直す。 */
    let announced: { paused?: string; next: number } | undefined;

    /** いまの残予算と実費から、次にいつ作るか。 */
    const schedule = (now: Date): SchedulerDecision => decide({
        now,
        lastAttemptAt: store.state.lastAttemptAt,
        remainingUsd: ledger.remainingThisMonth(),
        costPerAttemptUsd: ledger.costPerJob() ?? config.budget.perWorkUsd * UNKNOWN_COST_RATIO,
        maxAttemptsPerDay: config.production.attemptsPerDay
    });

    /** 次の予定を書く。休みに入った・明けた、または時刻が大きく動いたときだけ。 */
    const announceNext = (decision: SchedulerDecision): void => {
        const next = decision.next.getTime();
        if (announced && announced.paused === decision.paused && Math.abs(announced.next - next) < RESCHEDULE_NOTE_MS) return;
        announced = { paused: decision.paused, next };
        log.line(decision.paused
            ? `休む: ${decision.paused}。再開は ${clock(decision.next)}（${decision.reason}）`
            : `次の制作は ${clock(decision.next)}（${fromNow(decision.next)}）。${decision.reason}`);
    };

    for (;;) {
        const now = new Date();
        try {
            refresh();
            // 頼まれていれば受け取る。応じられなくても、ここで消える（頼みは溜めない）。
            const asked = takeRequest(root);
            let decision = schedule(now);
            if (asked) {
                log.line(decision.paused
                    ? `「いま作れ」と頼まれたが、${decision.paused}`
                    : "「いま作れ」と頼まれた。間隔を待たずに作り、出来たらその場で公開する");
                announced = undefined;
            }

            const due = !decision.paused && (options.once || resume || asked || decision.next.getTime() <= now.getTime());
            // これから作るなら「次は今」とは書かない。作り終えたところで次の予定を書く。
            if (!due) announceNext(decision);
            setPhase(decision.paused ? "paused" : "waiting", decision.next);

            let busy = false;
            if (due) {
                resume = false;
                busy = true;
                setPhase("making");
                // 始めた時刻を先に書く。作っている途中で落ちても、次の間隔はここから数える。
                store.change(s => { s.lastAttemptAt = new Date().toISOString(); });
                await makeOne(asked?.provider ?? options.provider);
            }

            // 送っていない採用作があれば、すぐ送る。送れなかったら間を置いて送り直す。
            if (Date.now() >= nextPublishAt && unpublished().length) {
                busy = true;
                setPhase("publishing");
                nextPublishAt = await publishOnce() ? 0 : Date.now() + PUBLISH_RETRY_MS;
            }
            // 作り終え、送り終えたら、その場で次の予定を書き、「待っている」に戻す。次に
            // 目を覚ますまで「作っている」ままに見えると、外から見届けている側が無駄に待つ。
            if (busy) {
                decision = schedule(new Date());
                announced = undefined;
                announceNext(decision);
                setPhase(decision.paused ? "paused" : "waiting", decision.next);
            }
            if (failures) {
                notifier.clear("loop");
                failures = 0;
            }
        } catch (e) {
            // 想定外。止めずに、間を置いて続ける。続くようなら人を呼ぶ。
            ++failures;
            log.line(`想定外の失敗（${failures}回目）: ${(e as Error).stack ?? String(e)}`);
            if (failures >= CALL_HUMAN_AFTER) {
                await notifier.tell("loop", `制作が${failures}回続けて失敗している: ${(e as Error).message}`);
            }
            setPhase("failing");
            await sleep(BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]);
            announced = undefined;
            continue;
        }

        if (options.once) {
            log.line("一周したので終わる（--once）");
            clearInterval(beating);
            lock.release();
            return 0;
        }
        await sleep(TICK_MS);
    }

    /**
     * 一作品つくる。中断していたジョブがあればその続きから。
     * 相手を指されていれば、その札だけの札束から引かせる。
     */
    async function makeOne(wanted?: string): Promise<void> {
        const job = jobs.unfinished()[0] ?? jobs.create();
        let hand = deck;
        if (wanted) {
            const only = deckNamed(deck, wanted);
            if (only) hand = only;
            else log.line(`札束に ${wanted} がいない。ふだんどおり引く`);
        }
        log.line(`▶ ${job.id}: 制作を始める（${job.state} から${options.fake ? "、偽のAI" : ""}）`);
        try {
            const done = await make({ config, deck: hand, ledger, jobs, archive, log }, job);
            log.line(summary(done, done.state === "accepted" ? archive.meta(done.id).title : undefined));
            notifier.clear("provider");
            if (done.state === "rejected") await reportRejected(done);
        } catch (e) {
            // 月の予算切れはスケジューラーが翌月まで休ませる。ジョブは残り、続きから再開する。
            if (e instanceof BudgetExceeded) log.line(`月間予算に達した: ${e.message}`);
            else if (e instanceof ProviderError && e.fatal) await notifier.tell("provider", `AIのAPIを使えない（${e.kind}）: ${e.message}`);
            else throw e;
        }
    }

    /**
     * 不採用を知らせる。人は呼ばない（日常の失敗）が、何を企画して、なぜ落ちたかは
     * 見えるようにする。同じ理由で落ち続けているなら、それが直すべきところ。
     * 偽のAIの不採用は送らない（作品の知らせと同じく、偽物は外へ出さない）。
     */
    async function reportRejected(job: Job): Promise<void> {
        if (options.fake) return;
        const f = facts(job);
        const reason = job.rejectReason ?? "理由不明";
        const fields: { name: string; value: string; inline?: boolean }[] = [
            { name: "不採用の理由", value: reason }
        ];
        if (f.lastProblems?.problems.length) {
            fields.push({ name: `最後の指摘（${f.lastProblems.stage}）`, value: f.lastProblems.problems.join("\n").slice(0, 800) });
        }
        fields.push({ name: "型", value: f.form, inline: true });
        if (f.author) fields.push({ name: "作者", value: f.author, inline: true });
        if (f.model) fields.push({ name: "モデル", value: f.model, inline: true });
        if (f.subject) fields.push({ name: "題材", value: f.subject });
        if (f.twist) fields.push({ name: "縛り", value: f.twist });
        fields.push({ name: "試行", value: f.attempts });
        fields.push({ name: "費用", value: `$${f.usd.toFixed(4)}（AI 呼出し ${f.calls} 回）`, inline: true });
        const title = f.title ?? "（企画の前に止まった）";
        await notifier.say(`不採用「${title}」— ${reason}`, [{
            title,
            // 企画の売り文句。Discord は embed 全体で 6000 字までなので、ここは短めに詰める。
            ...(f.pitch ? { description: f.pitch.slice(0, 1500) } : {}),
            color: COLOR.rejected,
            timestamp: job.updatedAt,
            fields,
            footer: { text: job.id }
        }]);
    }

    /** まだ送っていない採用作。 */
    function unpublished(): string[] {
        const sent = new Set(store.state.published);
        return archive.ids().filter(id => !sent.has(id));
    }

    /**
     * 出た作品を知らせる。人を呼ぶのとは別の、ただの便り。
     * 一作品につき embed を一つ。題を押せばその作品が開き、サムネイルは絵として出る。
     */
    async function announce(ids: readonly string[]): Promise<void> {
        if (!ids.length) return;
        const site = config.publish.siteUrl.replace(/\/$/, "");
        // 新しい順に。多いときは絵を並べても読みにくいので、最初の4件だけ。
        const shown = [...ids].reverse().slice(0, 4);
        const embeds = shown.map((id): Embed => {
            const meta = archive.meta(id);
            const thumb = { url: `${site}/works/${id}/thumb.png` };
            // 誰が書いたか。性格やモデル名を記録する前の作品には無いので、あるものだけ。
            const fields: { name: string; value: string; inline: boolean }[] = [];
            if (meta.penName) fields.push({ name: "作者", value: meta.penName, inline: true });
            if (meta.model) fields.push({ name: "モデル", value: meta.model, inline: true });
            fields.push({ name: "長さ", value: `${Math.round(meta.durationFrames / 60)}秒`, inline: true });
            if (meta.controls) fields.push({ name: "操作", value: meta.controls, inline: true });
            return {
                title: meta.title,
                url: `${site}/work/${encodeURIComponent(id)}/`,
                description: meta.description,
                color: COLOR.work,
                timestamp: meta.createdAt,
                fields,
                // 一作品だけなら大きく見せる。並ぶときは小さく添えて、題と説明を読ませる。
                ...(shown.length === 1 ? { image: thumb } : { thumbnail: thumb })
            };
        });
        const rest = ids.length - shown.length;
        await notifier.say(`新しい作品が出た（${ids.length}件）${rest ? `。うち新しい ${shown.length} 件` : ""}`, embeds);
    }

    /** 公開物を組み立てて送る。送れたら true。 */
    async function publishOnce(): Promise<boolean> {
        const fresh = unpublished();
        log.line(`公開へ進む（まだ送っていない作品 ${fresh.length} 件）`);
        const site = join(root, "site");
        const result = await assemble(join(root, "works"), site);
        log.line(`${site}: 作品 ${result.works} 件（新しくビルド ${result.built.length} 件、エンジン ${result.engines.length} 件）`);

        const done = () => store.change(s => {
            s.published = archive.ids();
            s.lastPublishAt = new Date().toISOString();
        });

        if (!options.publisher) {
            // 送り先がない（偽のAI、publish.target が none）。組み立てたところまでを覚えておく。
            done();
            return true;
        }
        try {
            await options.publisher.publish(site);
            const base = config.publish.siteUrl.replace(/\/$/, "");
            log.line([`${options.publisher.name} へ公開した（${fresh.length} 件）`,
                ...fresh.map(id => `    「${archive.meta(id).title}」 ${base}/work/${encodeURIComponent(id)}/`)].join("\n"));
            notifier.clear("publish");
            done();
            await announce(fresh);
            return true;
        } catch (e) {
            if (!(e instanceof PublishError)) throw e;
            // <VAR>/site/ はそのまま残る。作り直さずに送り直せる。
            if (e.fatal) await notifier.tell("publish", `公開できない（直すまで何度送っても同じ）: ${e.message}`);
            else log.line(`送れなかった（あとでもう一度）: ${e.message}`);
            return false;
        }
    }
}
