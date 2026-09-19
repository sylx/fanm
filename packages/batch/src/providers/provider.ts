// AI事業者への接続。特定の事業者への依存はこのディレクトリの中に閉じ込める。

export interface Usage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly usd: number;
}

export interface CompletionRequest {
    readonly system: string;
    readonly messages: readonly { role: "user" | "assistant"; content: string }[];
    readonly maxOutputTokens: number;
}

export interface Provider {
    readonly name: string;
    /** 予約に使う最大想定費用。 */
    estimateMaxUsd(request: CompletionRequest): number;
    complete(request: CompletionRequest): Promise<{ text: string; usage: Usage }>;
}
