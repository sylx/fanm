// 設定。config/fanm.json があればそれを、なければ既定値を使う。
// 認証情報は設定ファイルに書かず、環境変数で渡す（Coolify の環境変数）。
// 制作状態の置き場所は FANM_VAR（本番では永続ボリューム）。

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_MAX_OVERLAP } from "./check/overlap.js";

// .env があれば読む。ここで読んでおけば、APIキーも FANM_VAR もファイルで渡せる。
// 本番（Coolify）では環境変数が直接入るので .env は置かない。すでに環境にある値が優先。
if (existsSync(".env")) process.loadEnvFile(".env");

/** 頼む相手ひとり。札束の一枚（providers/deck.ts）。 */
export interface ProviderConfig {
    readonly name: "deepseek" | "claude" | "openai" | "fake";
    readonly model: string;
    /** 引かれやすさ。大きいほどよく当たる。0 なら引かない（札束に残したまま休ませる）。省くと 1。 */
    readonly share?: number;
    /** この相手に頼むときの一作品の上限（USD）。省くと budget.perWorkUsd。単価が10倍違う相手を同じ枠では測れない。 */
    readonly perWorkUsd?: number;
    /**
     * この相手のときに過去の作り手を呼び戻す割合。省くと persona.reuse。
     * 引かれることの少ない相手は、作り手も顔なじみになりにくいので高めにする。
     */
    readonly reuse?: number;
    /** APIキーの環境変数。省くと事業者ごとの既定（providers/ の各 API_KEY_ENV）。 */
    readonly apiKeyEnv?: string;
    /** 接続先。省くと事業者ごとの既定。 */
    readonly baseUrl?: string;
}

export interface Config {
    /** 頼む相手の札束。ジョブのたびに一人引く（providers/deck.ts）。 */
    readonly providers: readonly ProviderConfig[];
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
        /**
         * 実例や同じ型の過去作と、語の並びがどこまで一致していいか（0〜1）。
         * 超えた作品は書き写しとみなして作り直させる。1 にすると見逃す。
         */
        readonly maxOverlap: number;
    };
    readonly production: {
        readonly attemptsPerDay: number;
        readonly maxRepairs: number;
    };
    readonly persona: {
        /**
         * 過去の作り手を呼び戻す割合（0〜1）。引いた相手（モデル）に採用作のある
         * 作り手がいれば、この割合でその中から一人を選び、残りは性格を新しく引く。
         */
        readonly reuse: number;
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
        /** 公開したあとの居場所。知らせに貼るリンクに使うだけで、送り先は wrangler.jsonc が決める。 */
        readonly siteUrl: string;
    };
}

export const DEFAULTS: Config = {
    // 相手を変える・増やすときは config/fanm.json の providers を書き替える。鍵の
    // 環境変数と接続先は既定に任せる（書くと、相手を替えたときに前のものが残る）。
    providers: [{ name: "deepseek", model: "deepseek-v4-pro" }],
    budget: { monthlyUsd: 12, perWorkUsd: 0.5 },
    // maxTokens は思考の分も含む。DeepSeek V4 Pro は reasoning_effort: low でも
    // 上限まで考え切って本文を返さないことがあった（実測で2回続けて空）。
    // 思考なしなら23秒・3千トークンでコードが返り、検査も通る。
    // maxOverlap の根拠は check/overlap.ts。別の型のコード同士は 0.19 までに収まり、
    // 名前だけ変えた写しは 0.85 になった。
    generation: { planMaxTokens: 4000, generateMaxTokens: 16000, reasoningEffort: "none", maxOverlap: DEFAULT_MAX_OVERLAP },
    // 一作品 $0.02〜0.03 で収まっているので、一日6回でも月 $5 前後に留まる。
    production: { attemptsPerDay: 6, maxRepairs: 2 },
    // 性格を引くだけだと、同じ作り手が出るのは一モデル75人の中の偶然に任される。
    // 三作に一作ほどは顔なじみに書かせる。
    persona: { reuse: 0.3 },
    publish: {
        target: "cloudflare",
        wranglerConfig: "wrangler.jsonc",
        apiTokenEnv: "CLOUDFLARE_API_TOKEN",
        accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
        everyHours: 6,
        siteUrl: "https://fanm.oyabanare.com"
    }
};

type Partial2<T> = { [K in keyof T]?: Partial<T[K]> };

/** 設定ファイルの中身。節ごとに一部だけ書ける。札束だけは配列なので丸ごと差し替える。 */
type UserConfig = Partial2<Omit<Config, "providers">> & {
    providers?: readonly ProviderConfig[];
    /** 相手が一人しかいなかったころの書き方。まだ読む。 */
    provider?: ProviderConfig;
};

/** 設定の在り処。常駐はここを読み直す。 */
export const CONFIG_PATH = process.env.FANM_CONFIG ?? "config/fanm.json";

/**
 * 設定を読む。本番では永続ボリュームの上（FANM_CONFIG=/data/fanm.json）に置くと、
 * イメージを作り直さずに頻度や予算を変えられる。無ければ既定値。
 */
export function loadConfig(path = CONFIG_PATH): Config {
    if (!existsSync(path)) return DEFAULTS;
    const user = JSON.parse(readFileSync(path, "utf8")) as UserConfig;
    const providers = user.providers ?? (user.provider ? [user.provider] : DEFAULTS.providers);
    if (!providers.length) throw new Error(`${path}: providers が空。頼む相手を一人は書く`);
    return {
        providers,
        budget: { ...DEFAULTS.budget, ...user.budget },
        generation: { ...DEFAULTS.generation, ...user.generation },
        production: { ...DEFAULTS.production, ...user.production },
        persona: { ...DEFAULTS.persona, ...user.persona },
        publish: { ...DEFAULTS.publish, ...user.publish }
    };
}

/** 制作状態のルート。ジョブ、予算台帳、作品庫はすべてこの下。 */
export const VAR = resolve(process.env.FANM_VAR ?? "var");

/**
 * 設定ファイルを見張る。常駐はこれを繰り返し叩き、中身が変わっていたら読み直す。
 *
 * 置き場所を永続ボリュームにしたのは、イメージを作り直さずに予算や頻度を変える
 * ためだった。起動時に一度しか読まないなら、結局コンテナを入れ替えることになる。
 *
 * 読めないもの（書きかけ、壊れた JSON）は捨てて、前の設定のまま続ける。設定を
 * 直している最中の一瞬を掴んだだけで制作が止まるのは、割に合わない。同じ中身を
 * 二度は報せないので、壊れたまま置かれていても30秒ごとに言い続けたりはしない。
 */
export class ConfigWatch {
    private raw: string | null;

    constructor(private readonly path = CONFIG_PATH) {
        this.raw = read(this.path);
    }

    /**
     * 前に読んだときから中身が変わっていれば、新しい設定。変わっていなければ
     * undefined。読めなければ note に流して undefined（前のまま続ける合図）。
     */
    next(note: (line: string) => void): Config | undefined {
        const raw = read(this.path);
        if (raw === this.raw) return undefined;
        // 壊れていても覚える。同じ壊れ方を繰り返し報せないため。
        this.raw = raw;
        try {
            return loadConfig(this.path);
        } catch (e) {
            note(`設定を読めない。前のまま続ける: ${(e as Error).message}`);
            return undefined;
        }
    }
}

function read(path: string): string | null {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** 二つの設定で中身の違う節の名前。何が変わったかをログに出すため。 */
export function changedSections(before: Config, after: Config): (keyof Config)[] {
    return (Object.keys(after) as (keyof Config)[])
        .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
