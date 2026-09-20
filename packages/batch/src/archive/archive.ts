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
