// DeepSeek。OpenAI 互換の /chat/completions。
// https://api-docs.deepseek.com/api/create-chat-completion

import type { Completion, CompletionRequest, OnDelta, Provider, Usage } from "./provider.js";
import { ProviderError } from "./provider.js";

/** 1M トークンあたりの USD（ピーク時）。オフピークはこの半額。2026-09 時点。 */
const PRICES: Record<string, { hit: number; miss: number; output: number }> = {
    "deepseek-v4-pro": { hit: 0.044, miss: 1.32, output: 3.96 },
    "deepseek-flash": { hit: 0.006, miss: 0.3, output: 1.2 }
};

/**
 * ピーク時間帯は UTC 01:00-04:00 と 06:00-10:00（月〜金、中国の祝日を除く）。
 * 祝日は判定せず、ピーク扱いにして高めに数える。
 */
export function isPeak(at: Date): boolean {
    const day = at.getUTCDay();
    if (day === 0 || day === 6) return false;
    const hour = at.getUTCHours();
    return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** 入力トークン数の上限見積もり。日本語を含むので1文字1トークン寄りに高めに取る。 */
function maxInputTokens(request: CompletionRequest): number {
    return Math.ceil(request.messages.reduce((n, m) => n + m.content.length, 0) / 1.5);
}

interface StreamChunk {
    choices?: {
        delta?: { content?: string | null; reasoning_content?: string | null };
        finish_reason?: string | null;
    }[];
    usage?: Response["usage"];
}

interface Response {
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        prompt_cache_hit_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number; prompt_cache_hit_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
    };
}

export class DeepSeek implements Provider {
    readonly name = "deepseek";
    private readonly price: { hit: number; miss: number; output: number };

    constructor(
        readonly model: string,
        private readonly apiKey: string,
        private readonly baseUrl = "https://api.deepseek.com",
        /** 応答を待つ上限。思考つきの長い生成に合わせて長め。 */
        private readonly timeoutMs = 15 * 60_000
    ) {
        const price = PRICES[model];
        if (!price) throw new Error(`${model} の単価が分からない。providers/deepseek.ts の PRICES に足す`);
        this.price = price;
    }

    estimateMaxUsd(request: CompletionRequest): number {
        return (maxInputTokens(request) * this.price.miss + request.maxOutputTokens * this.price.output) / 1e6;
    }

    async complete(request: CompletionRequest, onDelta?: OnDelta): Promise<Completion> {
        const started = new Date();
        let response: globalThis.Response;
        try {
            response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
                body: JSON.stringify({
                    model: this.model,
                    messages: request.messages,
                    max_tokens: request.maxOutputTokens,
                    thinking: request.reasoningEffort === "none"
                        ? { type: "disabled" }
                        : { type: "enabled", reasoning_effort: request.reasoningEffort },
                    ...(request.json ? { response_format: { type: "json_object" } } : {}),
                    // 思考が長いので、届いた端から見せられるように流してもらう
                    stream: true,
                    stream_options: { include_usage: true }
                }),
                signal: AbortSignal.timeout(this.timeoutMs)
            });
        } catch (e) {
            throw new ProviderError(`DeepSeek に届かない: ${(e as Error).message}`, "network", "unknown");
        }

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            const message = `DeepSeek ${response.status}: ${body.slice(0, 500)}`;
            switch (response.status) {
                case 401: throw new ProviderError(message, "auth", false);
                case 402: throw new ProviderError(message, "quota", false);
                case 429: throw new ProviderError(message, "rate", false);
                case 400: case 422: throw new ProviderError(message, "bad-request", false);
                default: throw new ProviderError(message, response.status >= 500 ? "server" : "bad-request", "unknown");
            }
        }

        return this.readStream(response, started, onDelta);
    }

    /** SSE を読み、思考と本文を組み立てる。usage は最後のチャンクに入る。 */
    private async readStream(response: globalThis.Response, started: Date, onDelta?: OnDelta): Promise<Completion> {
        let content = "";
        let finish = "";
        let usage: Response["usage"] | undefined;
        let buffer = "";
        try {
            for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                buffer += Buffer.from(chunk).toString("utf8");
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                    if (!line.startsWith("data:")) continue;
                    const payload = line.slice(5).trim();
                    if (!payload || payload === "[DONE]") continue;
                    const event = JSON.parse(payload) as StreamChunk;
                    if (event.usage) usage = event.usage;
                    const choice = event.choices?.[0];
                    if (!choice) continue;
                    if (choice.finish_reason) finish = choice.finish_reason;
                    const reasoning = choice.delta?.reasoning_content;
                    if (reasoning) onDelta?.("reasoning", reasoning);
                    const text = choice.delta?.content;
                    if (text) {
                        content += text;
                        onDelta?.("content", text);
                    }
                }
            }
        } catch (e) {
            throw new ProviderError(`DeepSeek の応答が途中で切れた: ${(e as Error).message}`, "network", "unknown");
        }
        if (!usage) throw new ProviderError("DeepSeek が利用量を返さなかった", "server", "unknown");
        return { text: content, usage: this.usage(usage, started), truncated: finish === "length" };
    }

    private usage(raw: Response["usage"], at: Date): Usage {
        const cached = raw.prompt_cache_hit_tokens
            ?? raw.prompt_tokens_details?.prompt_cache_hit_tokens
            ?? raw.prompt_tokens_details?.cached_tokens
            ?? 0;
        const rate = isPeak(at) ? 1 : 0.5;
        const usd = rate * (
            cached * this.price.hit
            + (raw.prompt_tokens - cached) * this.price.miss
            + raw.completion_tokens * this.price.output
        ) / 1e6;
        return {
            inputTokens: raw.prompt_tokens,
            cachedInputTokens: cached,
            outputTokens: raw.completion_tokens,
            reasoningTokens: raw.completion_tokens_details?.reasoning_tokens ?? 0,
            usd
        };
    }
}
