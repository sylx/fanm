// AI事業者への接続。特定の事業者への依存はこのディレクトリの中に閉じ込める。

export interface Usage {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly usd: number;
}

export interface Message {
    readonly role: "system" | "user" | "assistant";
    readonly content: string;
}

export interface CompletionRequest {
    readonly messages: readonly Message[];
    readonly maxOutputTokens: number;
    readonly reasoningEffort: "none" | "low" | "high" | "max";
    /** JSON オブジェクトだけを返させる。 */
    readonly json?: boolean;
}

export interface Completion {
    readonly text: string;
    readonly usage: Usage;
    /** 出力上限で切れたなら true。 */
    readonly truncated: boolean;
}

/** 届いた端から呼ばれる。思考と本文を、待っている人に見せるため。 */
export type OnDelta = (kind: "reasoning" | "content", text: string) => void;

export interface Provider {
    readonly name: string;
    readonly model: string;
    /** 予約に使う最大想定費用（USD）。高めに見積もる。 */
    estimateMaxUsd(request: CompletionRequest): number;
    complete(request: CompletionRequest, onDelta?: OnDelta): Promise<Completion>;
}

/**
 * 呼出しの失敗。予算の精算と、止めるか再試行するかの判断に使う。
 *
 * - `billed: false`   相手が処理せずに断ったと分かっている（4xx）。費用ゼロで精算してよい。
 * - `billed: unknown` 途中で切れた・5xx など。予約額のまま確定する。
 */
export class ProviderError extends Error {
    constructor(
        message: string,
        readonly kind: "auth" | "quota" | "rate" | "server" | "network" | "bad-request",
        readonly billed: false | "unknown"
    ) {
        super(message);
    }

    /** 人が直さない限り直らない。処理を止めて知らせる。 */
    get fatal(): boolean {
        return this.kind === "auth" || this.kind === "quota";
    }

    /** 時間を置けば通るかもしれない。 */
    get retryable(): boolean {
        return this.kind === "rate" || this.kind === "server" || this.kind === "network";
    }
}
