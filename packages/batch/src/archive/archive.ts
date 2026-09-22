// 作品庫。採用作は <VAR>/works/<id>/ に保存する。
//
//     public/    ギャラリーに出すもの: work.ts, meta.json（WorkMeta）, thumbnail.png
//     private/   出さないもの: 企画、検査結果、AI 呼出しの記録と費用
//
// 公開用の work.js は publish の段階で public/work.ts からビルドする。
//
// TODO: 不採用作の jobs/ を保存期間と容量の上限で消す。

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkDescription, WorkMeta } from "@fanm/work";
import type { CheckReport } from "../check/check.js";
import type { Job } from "../jobs/job.js";
import type { KnownAuthor } from "../persona/pen-name.js";
import type { Plan } from "../plan/planner.js";

const ROOT = resolve(import.meta.dirname, "../../../..");

/**
 * 固定している fantasy-msx のコミット。作品はこの版のエンジンで動き続ける。
 *
 * 手元では git に訊く（submodule の指し先が常に正しい）。コンテナには .git も git も
 * ないので、リポジトリに入っている engine/COMMIT を読む。二つが食い違ったままの
 * イメージができないよう、Dockerfile がビルド時に突き合わせる。
 */
export function engineCommit(): string {
    if (process.env.FANM_ENGINE_COMMIT) return process.env.FANM_ENGINE_COMMIT;
    if (existsSync(join(ROOT, ".git"))) {
        return execFileSync("git", ["-C", join(ROOT, "engine/fantasy-msx"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    }
    return readFileSync(join(ROOT, "engine/COMMIT"), "utf8").trim();
}

/**
 * この作品のコードを書いたモデル。企画と生成を別の事業者に頼むこともあるので、
 * 最後の生成・修正の呼出しから採る。モデルを記録する前のジョブでは undefined。
 */
function modelOf(job: Job): string | undefined {
    for (let i = job.calls.length - 1; i >= 0; --i) {
        if (job.calls[i].purpose !== "plan") return job.calls[i].model || undefined;
    }
    return undefined;
}

export class Archive {
    constructor(readonly dir: string) {
        mkdirSync(dir, { recursive: true });
    }

    add(job: Job, attemptDir: string, report: CheckReport): WorkMeta {
        const root = join(this.dir, job.id);
        const pub = join(root, "public");
        const priv = join(root, "private");
        mkdirSync(pub, { recursive: true });
        mkdirSync(priv, { recursive: true });

        const description = JSON.parse(readFileSync(join(attemptDir, "meta.json"), "utf8")) as WorkDescription;
        const meta: WorkMeta = {
            id: job.id,
            title: description.title,
            description: description.description,
            controls: description.controls,
            durationFrames: report.scenario.frames,
            createdAt: new Date().toISOString(),
            engine: engineCommit(),
            model: modelOf(job),
            penName: job.persona?.penName,
            traits: job.persona?.traits,
            seed: job.seed,
            thumbnail: "thumbnail.png"
        };
        copyFileSync(join(attemptDir, "work.ts"), join(pub, "work.ts"));
        if (report.thumbnail) copyFileSync(report.thumbnail, join(pub, "thumbnail.png"));
        writeFileSync(join(pub, "meta.json"), JSON.stringify(meta, null, 2));

        writeFileSync(join(priv, "plan.json"), JSON.stringify(job.plan, null, 2));
        writeFileSync(join(priv, "report.json"), JSON.stringify(report, null, 2));
        writeFileSync(join(priv, "job.json"), JSON.stringify(job, null, 2));
        return meta;
    }

    /** 作品庫にある採用作のid。古い順。公開の要否を決めるのに使う。 */
    ids(): string[] {
        return readdirSync(this.dir)
            .filter(id => existsSync(join(this.dir, id, "public", "meta.json")))
            .sort();
    }

    /** 採用作の企画。無ければ undefined（型が入る前に作った作品）。 */
    plan(id: string): Plan | undefined {
        const path = join(this.dir, id, "private", "plan.json");
        return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Plan : undefined;
    }

    /** 公開している作品の説明。知らせに使う。 */
    meta(id: string): WorkMeta {
        return JSON.parse(readFileSync(join(this.dir, id, "public", "meta.json"), "utf8")) as WorkMeta;
    }

    /**
     * 同じ型の採用作のコード。新しい順。
     *
     * 新しい作品が過去作の書き写しになっていないかを見比べるために使う。企画の
     * 一覧と違い、こちらはコードそのものなので、数作だけ読む。
     */
    sources(form: string, limit = 3): { id: string; label: string; source: string }[] {
        const out: { id: string; label: string; source: string }[] = [];
        for (const id of readdirSync(this.dir).sort().reverse()) {
            if (out.length >= limit) break;
            const planPath = join(this.dir, id, "private", "plan.json");
            const workPath = join(this.dir, id, "public", "work.ts");
            if (!existsSync(planPath) || !existsSync(workPath)) continue;
            const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
            if ((plan.form ?? "") !== form) continue;
            out.push({ id, label: `過去作「${plan.title}」`, source: readFileSync(workPath, "utf8") });
        }
        return out;
    }

    /**
     * 採用作を書いたモデル。新しい順。頼む相手の偏りを避けるために使う。
     * モデル名を記録する前の作品は数えない（誰が書いたか分からないため）。
     */
    models(limit = 20): string[] {
        return readdirSync(this.dir)
            .sort()
            .reverse()
            .filter(id => existsSync(join(this.dir, id, "public", "meta.json")))
            .slice(0, limit)
            .map(id => this.meta(id).model)
            .filter((model): model is string => !!model);
    }

    /**
     * 作品庫に出たことのある作り手。ペンネームの台帳として読む（persona/pen-name.ts）。
     * 性格を持たせる前の作品は数えない。
     */
    authors(): KnownAuthor[] {
        return this.ids()
            .map(id => this.meta(id))
            .filter(meta => meta.model && meta.penName && meta.traits)
            .map(meta => ({ model: meta.model!, traits: meta.traits!, penName: meta.penName! }));
    }

    /** 採用済み作品の企画。新しい順。企画の偏りを避けるために使う。 */
    plans(limit = 40): Plan[] {
        return readdirSync(this.dir)
            .sort()
            .reverse()
            .map(id => join(this.dir, id, "private", "plan.json"))
            .filter(existsSync)
            .slice(0, limit)
            .map(path => JSON.parse(readFileSync(path, "utf8")) as Plan);
    }
}
