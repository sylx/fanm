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
}

export const DEFAULTS: Config = {
    provider: {
        name: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        baseUrl: "https://api.deepseek.com"
    },
    budget: { monthlyUsd: 12, perWorkUsd: 0.5 },
    // maxTokens は思考の分も含む。high だと思考だけで使い切ってコードが返らなかった。
    generation: { planMaxTokens: 4000, generateMaxTokens: 40000, reasoningEffort: "low" },
    production: { attemptsPerDay: 4, maxRepairs: 2 }
};

type Partial2<T> = { [K in keyof T]?: Partial<T[K]> };

export function loadConfig(path = "config/fanm.json"): Config {
    if (!existsSync(path)) return DEFAULTS;
    const user = JSON.parse(readFileSync(path, "utf8")) as Partial2<Config>;
    return {
        provider: { ...DEFAULTS.provider, ...user.provider },
        budget: { ...DEFAULTS.budget, ...user.budget },
        generation: { ...DEFAULTS.generation, ...user.generation },
        production: { ...DEFAULTS.production, ...user.production }
    };
}

/** 制作状態のルート。ジョブ、予算台帳、作品庫はすべてこの下。 */
export const VAR = resolve(process.env.FANM_VAR ?? "var");
