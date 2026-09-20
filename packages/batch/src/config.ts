// 設定。config/fanm.json があればそれを、なければ既定値を使う。
// 認証情報は設定ファイルに書かず、環境変数で渡す（Coolify の環境変数）。
// 制作状態の置き場所は FANM_VAR（本番では永続ボリューム）。

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// .env があれば読む。ここで読んでおけば、APIキーも FANM_VAR もファイルで渡せる。
// 本番（Coolify）では環境変数が直接入るので .env は置かない。すでに環境にある値が優先。
if (existsSync(".env")) process.loadEnvFile(".env");

export interface Config {
    readonly provider: {
        readonly name: "deepseek" | "fake";
        readonly model: string;
        readonly apiKeyEnv: string;
        readonly baseUrl: string;
    };
    readonly budget: {
        /** 月間上限（USD）。予約分も含めてこれを超える呼出しはしない。 */
        readonly monthlyUsd: number;
        /** 一作品（一ジョブ）の上限（USD）。 */
        readonly perWorkUsd: number;
    };
    readonly generation: {
        readonly planMaxTokens: number;
        readonly generateMaxTokens: number;
        /** 生成・修正時の思考の深さ。企画では使わない。 */
        readonly reasoningEffort: "none" | "low" | "high" | "max";
    };
    readonly production: {
        readonly attemptsPerDay: number;
        readonly maxRepairs: number;
    };
    readonly publish: {
        /** 送り先。"none" なら <VAR>/site/ を組み立てるだけで、どこへも送らない。 */
        readonly target: "cloudflare" | "none";
        /** Worker 名と公開ドメインが書いてあるファイル。置き場所（assets）は渡さない。 */
        readonly wranglerConfig: string;
        readonly apiTokenEnv: string;
        readonly accountIdEnv: string;
        /** 公開の間隔（時間）。制作より粗くして、溜まった作品をまとめて出す。 */
        readonly everyHours: number;
    };
}

export const DEFAULTS: Config = {
    provider: {
        name: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        baseUrl: "https://api.deepseek.com"
    },
    budget: { monthlyUsd: 12, perWorkUsd: 0.5 },
    // maxTokens は思考の分も含む。DeepSeek V4 Pro は reasoning_effort: low でも
    // 上限まで考え切って本文を返さないことがあった（実測で2回続けて空）。
    // 思考なしなら23秒・3千トークンでコードが返り、検査も通る。
    generation: { planMaxTokens: 4000, generateMaxTokens: 16000, reasoningEffort: "none" },
    production: { attemptsPerDay: 4, maxRepairs: 2 },
    publish: {
        target: "cloudflare",
        wranglerConfig: "wrangler.jsonc",
        apiTokenEnv: "CLOUDFLARE_API_TOKEN",
        accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
        everyHours: 6
    }
};

type Partial2<T> = { [K in keyof T]?: Partial<T[K]> };

/**
 * 設定を読む。本番では永続ボリュームの上（FANM_CONFIG=/data/fanm.json）に置くと、
 * イメージを作り直さずに頻度や予算を変えられる。無ければ既定値。
 */
export function loadConfig(path = process.env.FANM_CONFIG ?? "config/fanm.json"): Config {
    if (!existsSync(path)) return DEFAULTS;
    const user = JSON.parse(readFileSync(path, "utf8")) as Partial2<Config>;
    return {
        provider: { ...DEFAULTS.provider, ...user.provider },
        budget: { ...DEFAULTS.budget, ...user.budget },
        generation: { ...DEFAULTS.generation, ...user.generation },
        production: { ...DEFAULTS.production, ...user.production },
        publish: { ...DEFAULTS.publish, ...user.publish }
    };
}

/** 制作状態のルート。ジョブ、予算台帳、作品庫はすべてこの下。 */
export const VAR = resolve(process.env.FANM_VAR ?? "var");
