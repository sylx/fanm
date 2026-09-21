// OpenAI。公式SDKの Responses API を使う。
// https://developers.openai.com/api/docs/api-reference/responses
//
// DeepSeek と違うところだけ書いておく。
//
//   API          Chat Completions ではなく Responses。思考の要約を流してくれるのは
//                こちらだけ。
//   思考         いまの世代（gpt-5.6 以降）は切れない（none を送ると 400）。
//                バッチの「思考なし」は一番浅い effort に読み替える。
//   temperature  思考つきのモデルは受け取らない（送ると 400）。企画の温度は
//                ここでは効かない。散らすのは縛り（plan/variations.ts）の役目。
//   JSON         json_object は頼みのどこかに「JSON」の語が無いと 400 になる。
//                念のため一行足しておく。
//   キャッシュ   印を付けなくても先頭が揃えば効く。gpt-5.6 以降は書き込みが
//                入力の 1.25 倍、読み出しが 0.1 倍。それより前は書き込みも入力と同じ。

import OpenAI from "openai";
import type { Completion, CompletionRequest, OnDelta, Provider, Usage } from "./provider.js";
import { ProviderError } from "./provider.js";

/** APIキーを入れる環境変数。公式SDKが既定で読む名前に合わせる。 */
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";

/**
 * 1M トークンあたりの USD。2026-09 時点。write はキャッシュ書き込みが入力の何倍か。
 * 27.2万トークンを超える長い入力は割増しになるが、バッチの頼みはそこまで長くないので数えない。
 */
const PRICES: Record<string, { input: number; cached: number; output: number; write: number }> = {
    "gpt-6-astra": { input: 10, cached: 1, output: 50, write: 1.25 },
    // 2026-11-21 までの特価。戻ったら $5 / $0.5 / $30。
    "gpt-5.6-sol": { input: 4, cached: 0.4, output: 20, write: 1.25 },
    "gpt-5.6-terra": { input: 2, cached: 0.2, output: 12, write: 1.25 },
    "gpt-5.6-luna": { input: 0.2, cached: 0.02, output: 1.2, write: 1.25 },
    "gpt-5.5": { input: 5, cached: 0.5, output: 30, write: 1 }
};

/** 単価の分かっているモデル。鍵が無くても確かめられる。 */
export const OPENAI_MODELS = Object.keys(PRICES);

/** バッチの思考の深さを、OpenAI の effort に読み替える。 */
const EFFORT = { none: "low", low: "low", high: "high", max: "max" } as const;

/** JSON だけを返させるための一行。 */
const JSON_ONLY = "返事は JSON オブジェクトひとつだけにする。前置きも、囲みの ``` も書かない。";

/** 入力トークン数の上限見積もり。日本語を含むので1文字1トークン寄りに高めに取る。 */
function maxInputTokens(request: CompletionRequest): number {
    return Math.ceil(request.messages.reduce((n, m) => n + m.content.length, 0) / 1.5);
}

/** SDK の失敗を、予算の精算と再試行の判断ができる形に直す。 */
function asProviderError(e: unknown): ProviderError {
    if (!(e instanceof OpenAI.APIError)) {
        return new ProviderError(`OpenAI の呼出しが壊れた: ${(e as Error).message}`, "network", "unknown");
    }
    const message = `OpenAI ${e.status ?? "接続失敗"}: ${e.message.slice(0, 500)}`;
    // 残高切れも 429 で来る。code で一時的な混雑と見分ける。
    if (e.code === "insufficient_quota") return new ProviderError(message, "quota", false);
    switch (e.status) {
        case 401: case 403: return new ProviderError(message, "auth", false);
        case 429: return new ProviderError(message, "rate", false);
        case 400: case 404: case 422: return new ProviderError(message, "bad-request", false);
        // 応答が届かなかった（status なし）か、流している途中の error イベント。
        case undefined: return new ProviderError(message, "network", "unknown");
        default: return new ProviderError(message, e.status >= 500 ? "server" : "bad-request", "unknown");
    }
}

export class OpenAIProvider implements Provider {
    readonly name = "openai";
    private readonly price: { input: number; cached: number; output: number; write: number };
    private readonly client: OpenAI;

    constructor(
        readonly model: string,
        apiKey: string,
        baseUrl?: string,
        /** 応答を待つ上限。思考つきの長い生成に合わせて長め。 */
        timeoutMs = 15 * 60_000
    ) {
        const price = PRICES[model];
        if (!price) throw new Error(`${model} の単価が分からない。providers/openai.ts の PRICES に足す`);
        this.price = price;
        this.client = new OpenAI({
            apiKey,
            ...(baseUrl ? { baseURL: baseUrl } : {}),
            timeout: timeoutMs,
            // 再試行は call.ts の役目。SDK に隠れて繰り返されると、台帳の予約と噛み合わない。
            maxRetries: 0
        });
    }

    estimateMaxUsd(request: CompletionRequest): number {
        // 初回は全部キャッシュ書き込みになりうるので、その単価で見積もる。
        return (maxInputTokens(request) * this.price.input * this.price.write
            + request.maxOutputTokens * this.price.output) / 1e6;
    }

    /**
     * 途中までの費用の見当。中断された呼出しを、予約額そのままではなく
     * これで確定する。届いた文字数から出したおおよその値。
     */
    estimatePartialUsd(request: CompletionRequest, outputChars: number): number {
        return (maxInputTokens(request) * this.price.input + (outputChars / 3) * this.price.output) / 1e6;
    }

    async complete(request: CompletionRequest, onDelta?: OnDelta): Promise<Completion> {
        const input: OpenAI.Responses.EasyInputMessage[] = request.messages.map(m => ({ role: m.role, content: m.content }));
        if (request.json) input.push({ role: "developer", content: JSON_ONLY });
        let response: OpenAI.Responses.Response;
        try {
            const stream = this.client.responses.stream({
                model: this.model,
                input,
                max_output_tokens: request.maxOutputTokens,
                // 思考は要約で流してもらう。待っている人に何をしているか見せるため。
                reasoning: { effort: EFFORT[request.reasoningEffort], summary: "auto" },
                ...(request.json ? { text: { format: { type: "json_object" } } } : {}),
                // 会話を OpenAI 側に残さない。続きから頼むことはない。
                store: false
            });
            for await (const event of stream) {
                if (event.type === "response.reasoning_summary_text.delta") onDelta?.("reasoning", event.delta);
                else if (event.type === "response.output_text.delta") onDelta?.("content", event.delta);
            }
            response = await stream.finalResponse();
        } catch (e) {
            throw asProviderError(e);
        }

        if (response.status === "failed") {
            throw new ProviderError(
                `OpenAI が失敗した（${response.error?.code ?? "理由なし"}）: ${response.error?.message ?? ""}`,
                "server", "unknown"
            );
        }
        // 断られた。同じ頼みで繰り返しても同じなので、再試行にはしない。
        const refusal = response.output
            .flatMap(item => (item.type === "message" ? item.content : []))
            .find(c => c.type === "refusal");
        if (refusal) throw new ProviderError(`OpenAI が応じなかった: ${refusal.refusal}`, "bad-request", "unknown");
        if (!response.usage) throw new ProviderError("OpenAI が利用量を返さなかった", "server", "unknown");

        return {
            text: response.output_text,
            usage: this.usage(response.usage),
            truncated: response.incomplete_details?.reason === "max_output_tokens"
        };
    }

    /**
     * 利用量と費用。OpenAI の input_tokens はキャッシュの読み書きを含む
     * （DeepSeek の prompt_tokens と同じ意味）ので、そのまま台帳に入れる。
     */
    private usage(raw: OpenAI.Responses.ResponseUsage): Usage {
        const read = raw.input_tokens_details?.cached_tokens ?? 0;
        const written = raw.input_tokens_details?.cache_write_tokens ?? 0;
        const usd = (
            (raw.input_tokens - read - written) * this.price.input
            + written * this.price.input * this.price.write
            + read * this.price.cached
            + raw.output_tokens * this.price.output
        ) / 1e6;
        return {
            inputTokens: raw.input_tokens,
            cachedInputTokens: read,
            outputTokens: raw.output_tokens,
            reasoningTokens: raw.output_tokens_details?.reasoning_tokens ?? 0,
            usd
        };
    }
}
