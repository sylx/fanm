// Claude（Anthropic）。公式SDKの Messages API を使う。
// https://platform.claude.com/docs/en/api/messages
//
// DeepSeek と違うところだけ書いておく。
//
//   system       messages に混ぜず外へ出す。制作ルールとAPI資料で6万字あり、
//                どの呼出しでも同じ先頭なので、ここにキャッシュの印を付ける。
//   思考         切れない。切ると本文に思考が混じることがあるので、バッチの
//                「思考なし」は一番浅い effort に読み替える。
//   temperature  いまの世代のモデルは受け取らない（送ると 400）。企画の温度は
//                ここでは効かない。散らすのは縛り（plan/variations.ts）の役目。
//   JSON         「JSONだけ返す」設定が無い。schema を渡す構造化出力はあるが、
//                この層は schema を知らないので、頼みに一行足して、囲みが
//                付いて返ってきたら外す。

import Anthropic from "@anthropic-ai/sdk";
import type { Completion, CompletionRequest, OnDelta, Provider, Usage } from "./provider.js";
import { ProviderError } from "./provider.js";

/** APIキーを入れる環境変数。公式SDKが既定で読む名前に合わせる。 */
export const CLAUDE_API_KEY_ENV = "ANTHROPIC_API_KEY";

/** 1M トークンあたりの USD。2026-09 時点。 */
const PRICES: Record<string, { input: number; output: number }> = {
    "claude-opus-5": { input: 5, output: 25 },
    "claude-opus-4-8": { input: 5, output: 25 },
    "claude-sonnet-5": { input: 2, output: 10 }
};

/** キャッシュの単価は入力の何倍か。読み出しは安く、書き込みは少し高い（5分もつ）。 */
const CACHE = { read: 0.1, write: 1.25 } as const;

/** バッチの思考の深さを、Claude の effort に読み替える。 */
const EFFORT = { none: "low", low: "low", high: "high", max: "max" } as const;

/** JSON だけを返させるための一行。system の末尾に足す。 */
const JSON_ONLY = "返事は JSON オブジェクトひとつだけにする。前置きも、囲みの ``` も書かない。";

/** 入力トークン数の上限見積もり。日本語を含むので1文字1トークン寄りに高めに取る。 */
function maxInputTokens(request: CompletionRequest): number {
    return Math.ceil(request.messages.reduce((n, m) => n + m.content.length, 0) / 1.5);
}

/**
 * バッチの会話を Claude の形に分ける。
 *
 * 変わらない system を一つ目の塊にして、そこにキャッシュの印を置く。JSON の
 * 頼みは印より後ろの別の塊にする。同じ印より前が一字も変わらないので、企画でも
 * 生成でも同じキャッシュが効く。
 */
function split(request: CompletionRequest): {
    system: Anthropic.TextBlockParam[];
    messages: Anthropic.MessageParam[];
} {
    const stable = request.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const system: Anthropic.TextBlockParam[] = [
        { type: "text", text: stable, cache_control: { type: "ephemeral" } }
    ];
    if (request.json) system.push({ type: "text", text: JSON_ONLY });
    const messages = request.messages
        .filter((m): m is { role: "user" | "assistant"; content: string } => m.role !== "system")
        .map(m => ({ role: m.role, content: m.content }));
    return { system, messages };
}

/** 囲みが付いて返ってきた JSON を裸にする。 */
function unfence(text: string): string {
    const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
    return (fenced ? fenced[1] : text).trim();
}

/**
 * SDK の失敗を、予算の精算と再試行の判断ができる形に直す。
 *
 * 種別は本文の `type`（rate_limit_error など）で見る。HTTP の番号より細かく、
 * 残高切れ（billing_error）と一時的な混雑（overloaded_error）を取り違えない。
 */
function asProviderError(e: unknown): ProviderError {
    if (!(e instanceof Anthropic.APIError)) {
        return new ProviderError(`Claude の呼出しが壊れた: ${(e as Error).message}`, "network", "unknown");
    }
    const message = `Claude ${e.status ?? "接続失敗"}: ${e.message.slice(0, 500)}`;
    switch (e.type) {
        case "authentication_error": case "permission_error": return new ProviderError(message, "auth", false);
        case "billing_error": return new ProviderError(message, "quota", false);
        case "rate_limit_error": return new ProviderError(message, "rate", false);
        // 混んでいて受け取ってもらえなかった。処理されていないので費用はゼロ。
        case "overloaded_error": return new ProviderError(message, "server", false);
        case "invalid_request_error": case "not_found_error": return new ProviderError(message, "bad-request", false);
        // timeout_error, api_error と、応答が届かなかった場合（status なし）。
        default: return new ProviderError(message, e.status === undefined ? "network" : "server", "unknown");
    }
}

export class Claude implements Provider {
    readonly name = "claude";
    private readonly price: { input: number; output: number };
    private readonly client: Anthropic;

    constructor(
        readonly model: string,
        apiKey: string,
        baseUrl?: string,
        /** 応答を待つ上限。思考つきの長い生成に合わせて長め。 */
        timeoutMs = 15 * 60_000
    ) {
        const price = PRICES[model];
        if (!price) throw new Error(`${model} の単価が分からない。providers/claude.ts の PRICES に足す`);
        this.price = price;
        this.client = new Anthropic({
            apiKey,
            ...(baseUrl ? { baseURL: baseUrl } : {}),
            timeout: timeoutMs,
            // 再試行は call.ts の役目。SDK に隠れて繰り返されると、台帳の予約と噛み合わない。
            maxRetries: 0
        });
    }

    estimateMaxUsd(request: CompletionRequest): number {
        return (maxInputTokens(request) * this.price.input + request.maxOutputTokens * this.price.output) / 1e6;
    }

    /**
     * 途中までの費用の見当。中断された呼出しを、予約額そのままではなく
     * これで確定する。届いた文字数から出したおおよその値。
     */
    estimatePartialUsd(request: CompletionRequest, outputChars: number): number {
        return (maxInputTokens(request) * this.price.input + (outputChars / 3) * this.price.output) / 1e6;
    }

    async complete(request: CompletionRequest, onDelta?: OnDelta): Promise<Completion> {
        const { system, messages } = split(request);
        let message: Anthropic.Message;
        try {
            const stream = this.client.messages.stream({
                model: this.model,
                max_tokens: request.maxOutputTokens,
                system,
                messages,
                // 思考は要約で流してもらう。待っている人に何をしているか見せるため。
                thinking: { type: "adaptive", display: "summarized" },
                output_config: { effort: EFFORT[request.reasoningEffort] }
            });
            for await (const event of stream) {
                if (event.type !== "content_block_delta") continue;
                if (event.delta.type === "thinking_delta") onDelta?.("reasoning", event.delta.thinking);
                else if (event.delta.type === "text_delta") onDelta?.("content", event.delta.text);
            }
            message = await stream.finalMessage();
        } catch (e) {
            throw asProviderError(e);
        }

        // 断られた。同じ頼みで繰り返しても同じなので、再試行にはしない。
        if (message.stop_reason === "refusal") {
            throw new ProviderError(
                `Claude が応じなかった（${message.stop_details?.category ?? "理由なし"}）: ${message.stop_details?.explanation ?? ""}`,
                "bad-request", "unknown"
            );
        }

        const text = message.content.filter(b => b.type === "text").map(b => b.text).join("");
        return {
            text: request.json ? unfence(text) : text,
            usage: this.usage(message.usage),
            // 文脈の上限に当たったときも、こちらから見れば「長すぎて切れた」。
            truncated: message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded"
        };
    }

    /**
     * 利用量と費用。Claude の input_tokens はキャッシュ分を含まないので、
     * 台帳には三つ足した数を入れる（DeepSeek の prompt_tokens と同じ意味にする）。
     */
    private usage(raw: Anthropic.Usage): Usage {
        const read = raw.cache_read_input_tokens ?? 0;
        const written = raw.cache_creation_input_tokens ?? 0;
        const usd = (
            raw.input_tokens * this.price.input
            + written * this.price.input * CACHE.write
            + read * this.price.input * CACHE.read
            + raw.output_tokens * this.price.output
        ) / 1e6;
        return {
            inputTokens: raw.input_tokens + written + read,
            cachedInputTokens: read,
            outputTokens: raw.output_tokens,
            reasoningTokens: raw.output_tokens_details?.thinking_tokens ?? 0,
            usd
        };
    }
}
