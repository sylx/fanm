#!/usr/bin/env -S npx tsx
// バッチ処理の入口。
//
//     fanm run [--once]         常駐して制作を回し続ける。本番（Coolify）はこれを動かす
//     fanm make [--fake]        ジョブを一つ最後まで進める。途中のジョブがあればその続きから
//     fanm makenow [--local]    次の間隔を待たずに一作品つくって公開する。常駐が動いていれば横から頼む
//     fanm check <dir>...       work.ts と meta.json のあるディレクトリを検査する（AIは呼ばない）
//     fanm status               いまどうなっているか。動いていなければ終了コード 1
//     fanm budget               今月の使用額
//     fanm publish [--local]    採用作から公開物を組み立て（<VAR>/site/）、Cloudflare へ送る
//                               --local は組み立てるところまで。偽のAIの作品も送らない
//
// 制作は一度に一つだけ。すでに動いていれば、make はその様子を映すだけにし、
// makenow は動いている常駐に「いま作れ」と頼んで、その様子を映す。
//
// --fake は APIキーなしで一周させる偽のAIを使う。予算台帳も別（<VAR>/fake/）。

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Archive } from "./archive/archive.js";
import { BudgetExceeded, Ledger } from "./budget/ledger.js";
import { checkWork } from "./check/check.js";
import { loadConfig, VAR } from "./config.js";
import { JobStore } from "./jobs/job.js";
import { make } from "./jobs/make.js";
import { DeepSeek } from "./providers/deepseek.js";
import { CloudflarePublisher, PublishError, type Publisher } from "./publish/publisher.js";
import { assemble } from "./publish/site.js";
import { acquire, isRunning } from "./run/lock.js";
import { runLoop } from "./run/loop.js";
import { askNow, asked, takeRequest } from "./run/request.js";
import { readState } from "./run/state.js";
import { status } from "./run/status.js";
import { follow, Log, logPath } from "./run/log.js";
import { FakeProvider } from "./providers/fake.js";
import { ProviderError, type Provider } from "./providers/provider.js";

/** 台帳の生の中身。内訳を見せるためだけに読む。 */
function readLedger(varDir: string): { status: string; usd?: number; maxUsd: number }[] {
    const path = join(varDir, "ledger", `${new Date().toISOString().slice(0, 7)}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}

const config = loadConfig();
const [command, ...args] = process.argv.slice(2);
const fake = args.includes("--fake") || config.provider.name === "fake";
const root = fake ? join(VAR, "fake") : VAR;
const ledger = () => new Ledger(join(root, "ledger"), config.budget);

function provider(): Provider {
    if (fake) return new FakeProvider();
    const key = process.env[config.provider.apiKeyEnv];
    if (!key) throw new Error(`環境変数 ${config.provider.apiKeyEnv} に APIキーがない`);
    return new DeepSeek(config.provider.model, key, config.provider.baseUrl);
}

async function runMake(): Promise<number> {
    mkdirSync(root, { recursive: true });
    const lock = acquire(root);
    if (!lock.held) {
        // 二重に走らせない。代わりに、動いている方の様子（AIの思考も）を映す。
        console.log(`すでに制作が動いている（pid ${lock.by.pid}、${lock.by.since} 開始）。その様子を映す。Ctrl-C で見るのをやめても、制作は続く。`);
        await follow(root);
        console.log("\n制作が終わった。");
        return 0;
    }

    const log = new Log(logPath(root));
    const budget = ledger();
    const swept = budget.sweepReserved();
    if (swept) log.line(`前回の中断で予約のまま残っていた ${swept} 件を、予約額のまま確定した`);

    const jobs = new JobStore(join(root, "jobs"));
    const job = jobs.unfinished()[0] ?? jobs.create();
    log.line(`${job.id}: ${job.state} から開始${fake ? "（偽のAI）" : ""}`);
    try {
        const done = await make({ config, provider: provider(), ledger: budget, jobs, archive: new Archive(join(root, "works")), log }, job);
        const usd = done.calls.reduce((n, c) => n + c.usd, 0);
        log.line(`${done.id}: ${done.state}（AI 呼出し ${done.calls.length} 回、$${usd.toFixed(4)}）`);
        return done.state === "accepted" ? 0 : 1;
    } catch (e) {
        if (e instanceof BudgetExceeded) log.line(`月間予算に達したので止める: ${e.message}`);
        else if (e instanceof ProviderError && e.fatal) log.line(`人の対応が必要: ${e.message}`);
        else throw e;
        return 2;
    } finally {
        lock.release();
    }
}

/**
 * 頼んだ制作を見届ける。常駐は終わらないので、頼みが受け取られ、作り終えて
 * 静かになったところで戻る。最後に見えた様子を返す。
 */
async function watchRequest(): Promise<string> {
    let taken = false;      // 常駐が頼みを受け取った
    let began = false;      // 受け取ったあと、本当に作り始めた
    let phase = "";
    await follow(root, {
        until: () => {
            // 受け取られるまでは、いま何をしていても見続ける（前の作品の途中かもしれない）。
            if (!taken) {
                taken = asked(root) === null;
                return false;
            }
            phase = readState(root).beat?.phase ?? "";
            if (phase === "making" || phase === "publishing") {
                began = true;
                return false;
            }
            // 始まったなら、終わって静かになった。休んでいるなら、受け取ったが応じない。
            return began || phase === "paused";
        }
    });
    return phase;
}

/** 次の間隔を待たずに一作品。常駐が動いていれば頼み、いなければ自分で作って公開する。 */
async function runMakeNow(local: boolean): Promise<number> {
    mkdirSync(root, { recursive: true });
    const running = isRunning(root);
    if (running) {
        if (readState(root).beat?.phase === "making") {
            console.log("いま別の作品を作っている。それが終わってから、続けてもう一作品つくる。");
        }
        askNow(root);
        console.log(`常駐（pid ${running.pid}）に「いま作れ」と頼んだ。30秒以内に始まる。Ctrl-C で見るのをやめても、制作は続く。`);
        const phase = await watchRequest();
        if (asked(root) === null) {
            if (phase !== "paused") return 0;
            console.log("常駐は休んでいるので作らなかった。fanm status で理由を見る。");
            return 1;
        }
        // 鍵は握られていたが、頼みを受け取る相手ではなかった（fanm make が動いていて、終わった）。
        takeRequest(root);
        console.log("頼みを受け取る常駐がいなかった。ここで作る。");
    }
    return await runLoop({ config, root, fake, provider: provider(), publisher: publisher(local), once: true });
}

async function runCheck(dir: string): Promise<number> {
    // 検査は作業ディレクトリに tsconfig.json や撮影を書くので、写してから行う
    const work = join(root, "check", basename(resolve(dir)));
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    for (const file of ["work.ts", "meta.json"]) copyFileSync(join(dir, file), join(work, file));
    const report = await checkWork(work, 1);
    console.log(`撮影: ${join(work, "check")}`);
    console.log(`${report.stage}${report.ok ? "" : "\n" + report.problems.join("\n")}\n${report.observations}`);
    return report.ok ? 0 : 1;
}

/** 送り先。偽のAIで作った作品は公開しない。 */
function publisher(local: boolean): Publisher | undefined {
    if (local) return undefined;
    if (fake) {
        console.log("偽のAIの作品なので送らない");
        return undefined;
    }
    if (config.publish.target === "none") return undefined;
    return new CloudflarePublisher({ ...config.publish, log: text => process.stdout.write(text) });
}

async function runSend(siteDir: string, local: boolean): Promise<number> {
    const send = publisher(local);
    if (!send) return 0;
    const log = new Log(logPath(root));
    log.line(`${send.name} へ送る`);
    try {
        await send.publish(siteDir);
        log.line("公開した");
        return 0;
    } catch (e) {
        if (!(e instanceof PublishError)) throw e;
        // 組み立て済みの <VAR>/site/ はそのまま残る。作り直さずに publish をやり直せる。
        log.line(`${e.fatal ? "人の対応が必要" : "送れなかった（あとでもう一度）"}: ${e.message}`);
        return 2;
    }
}

switch (command) {
    case "run":
        process.exitCode = await runLoop({
            config,
            root,
            fake,
            provider: provider(),
            publisher: publisher(args.includes("--local")),
            once: args.includes("--once")
        });
        break;
    case "status": {
        const report = status(root, config);
        console.log(report.text);
        process.exitCode = report.healthy ? 0 : 1;
        break;
    }
    case "make":
        process.exitCode = await runMake();
        break;
    case "makenow":
        process.exitCode = await runMakeNow(args.includes("--local"));
        break;
    case "check": {
        const dirs = args.filter(a => !a.startsWith("--"));
        if (!dirs.length) throw new Error("usage: fanm check <dir>...");
        let failed = 0;
        for (const dir of dirs) {
            if (dirs.length > 1) console.log(`\n=== ${dir} ===`);
            failed += await runCheck(dir);
        }
        process.exitCode = failed ? 1 : 0;
        break;
    }
    case "publish": {
        const site = join(root, "site");
        const result = await assemble(join(root, "works"), site);
        console.log(`${site}: 作品 ${result.works} 件`);
        if (result.engines.length) console.log(`  エンジンを追加: ${result.engines.join(", ")}`);
        console.log(result.built.length ? `  作品をビルド: ${result.built.join(", ")}` : "  新しくビルドした作品はない");
        if (result.removed.length) console.log(`  古い殻を掃除: ${result.removed.join(", ")}`);
        process.exitCode = await runSend(site, args.includes("--local"));
        break;
    }
    case "budget": {
        const entries = readLedger(root);
        const sum = (status: string) => entries.filter(e => e.status === status)
            .reduce((n, e) => n + (e.status === "settled" ? e.usd ?? 0 : e.maxUsd), 0);
        console.log(`今月 $${ledger().spentThisMonth().toFixed(4)} / $${config.budget.monthlyUsd}`);
        console.log(`  確定 $${sum("settled").toFixed(4)}（${entries.filter(e => e.status === "settled").length}件）`);
        console.log(`  請求不明 $${sum("unknown").toFixed(4)}（${entries.filter(e => e.status === "unknown").length}件、予約額のまま計上）`);
        console.log(`  実行中 $${sum("reserved").toFixed(4)}（${entries.filter(e => e.status === "reserved").length}件）`);
        break;
    }
    default:
        console.error("usage: fanm run [--once] | make [--fake] | makenow [--local] | check <dir> | status | publish [--local] | budget");
        process.exitCode = 2;
}
