// Gemini（Google）。公式SDKの generateContent を使う。
// https://ai.google.dev/api/generate-content
//
// DeepSeek と違うところだけ書いておく。
//
//   system       messages に混ぜず systemInstruction へ出す。assistant は model と呼ぶ。
//   思考         thinkingLevel で深さを選ぶ。切れない（minimal でも切れるとは限らず、
//                受け付けないモデルもある）。バッチの「思考なし」は low に、max は
//                high に読み替える。
//   temperature  Gemini 3 以降は既定の 1.0 から下げると堂々巡りすることがある、と
//                Google が言っている。送らない。散らすのは縛り（plan/variations.ts）の役目。
//   JSON         responseMimeType で JSON だけを返させられる。思考は別の部品で来るので混じらない。
//   キャッシュ   印を付けなくても先頭が揃えば効く（暗黙のキャッシュ）。書き込みの割増しは無い。
//   続き         出力が一回の上限に当たると CONTINUATION で止まり、SDK は既定で続きを
//                頼み直す。一呼出しのつもりで予約しているので切っておき、切れたものとして返す。

import { ApiError, FinishReason, GoogleGenAI, ThinkingLevel, type Content, type GenerateContentResponseUsageMetadata } from "@google/genai";
import type { Completion, CompletionRequest, OnDelta, Provider, Usage } from "./provider.js";
import { ProviderError } from "./provider.js";

/** APIキーを入れる環境変数。公式SDKが既定で読む名前に合わせる。 */
export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";

/**
 * 1M トークンあたりの USD。2026-10 時点。cached は暗黙のキャッシュの読み出し。
 * 20万トークンを超える長い入力は割増しになるモデルがあるが、バッチの頼みはそこまで長くないので数えない。
 */
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
    // 2026-12-01 からは $4 / $0.2 / $20 に上がる。
    "gemini-4-argon": { input: 2, cached: 0.1, output: 10 },
    // 2027-01-01 からは $1.5 / $0.15 / $7.5 に上がる。
    "gemini-3.8-flash": { input: 0.75, cached: 0.075, output: 3.75 },
    "gemini-3.6-flash": { input: 0.75, cached: 0.075, output: 3.75 },
    "gemini-3.5-flash-lite": { input: 0.3, cached: 0.03, output: 2.5 },
    "gemini-3.1-pro-preview": { input: 2, cached: 0.2, output: 12 }
};

/** 単価の分かっているモデル。鍵が無くても確かめられる。 */
export const GEMINI_MODELS = Object.keys(PRICES);

/** バッチの思考の深さを、Gemini の thinkingLevel に読み替える。 */
const LEVEL = { none: ThinkingLevel.LOW, low: ThinkingLevel.LOW, high: ThinkingLevel.HIGH, max: ThinkingLevel.HIGH } as const;

/** 書いてもらえなかった止まり方。同じ頼みで繰り返しても同じなので、再試行にはしない。 */
const REFUSED: readonly string[] = [
    FinishReason.SAFETY, FinishReason.RECITATION, FinishReason.LANGUAGE, FinishReason.BLOCKLIST,
    FinishReason.PROHIBITED_CONTENT, FinishReason.SPII
];

/** 入力トークン数の上限見積もり。日本語を含むので1文字1トークン寄りに高めに取る。 */
function maxInputTokens(request: CompletionRequest): number {
    return Math.ceil(request.messages.reduce((n, m) => n + m.content.length, 0) / 1.5);
}

/** バッチの会話を Gemini の形に分ける。system は一つにまとめて先頭に置き、キャッシュの効く先頭を揃える。 */
function split(request: CompletionRequest): { system: string | undefined; contents: Content[] } {
    const system = request.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const contents = request.messages
        .filter(m => m.role !== "system")
        .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    return { system: system || undefined, contents };
}

/**
 * SDK の失敗を、予算の精算と再試行の判断ができる形に直す。
 *
 * 鍵の誤りは 401 ではなく 400 で来るので、本文の API_KEY_INVALID で見分ける。
 */
function asProviderError(e: unknown): ProviderError {
    if (!(e instanceof ApiError)) {
        return new ProviderError(`Gemini の呼出しが壊れた: ${(e as Error).message}`, "network", "unknown");
    }
    const message = `Gemini ${e.status}: ${e.message.slice(0, 500)}`;
    if (e.message.includes("API_KEY_INVALID")) return new ProviderError(message, "auth", false);
    switch (e.status) {
        case 401: case 403: return new ProviderError(message, "auth", false);
        // プリペイドの残高切れ。
        case 402: return new ProviderError(message, "quota", false);
        case 429: return new ProviderError(message, "rate", false);
        case 400: case 404: return new ProviderError(message, "bad-request", false);
        // 混んでいて受け取ってもらえなかった。処理されていないので費用はゼロ。
        case 503: return new ProviderError(message, "server", false);
        default: return new ProviderError(message, e.status >= 500 ? "server" : "bad-request", "unknown");
    }
}

export class Gemini implements Provider {
    readonly name = "gemini";
    private readonly price: { input: number; cached: number; output: number };
    private readonly client: GoogleGenAI;

    constructor(
        readonly model: string,
        apiKey: string,
        baseUrl?: string,
        /** 応答を待つ上限。思考つきの長い生成に合わせて長め。 */
        timeoutMs = 15 * 60_000
    ) {
        const price = PRICES[model];
        if (!price) throw new Error(`${model} の単価が分からない。providers/gemini.ts の PRICES に足す`);
        this.price = price;
        // retryOptions を渡さなければ SDK は繰り返さない。再試行は call.ts の役目。
        this.client = new GoogleGenAI({
            apiKey,
            httpOptions: { ...(baseUrl ? { baseUrl } : {}), timeout: timeoutMs }
        });
    }

    estimateMaxUsd(request: CompletionRequest): number {
        // 思考も maxOutputTokens の内に入るので、出力の上限はそのまま使える。
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
        const { system, contents } = split(request);
        let text = "";
        let finish: string | undefined;
        let blocked: string | undefined;
        let usage: GenerateContentResponseUsageMetadata | undefined;
        try {
            const stream = await this.client.models.generateContentStream({
                model: this.model,
                contents,
                config: {
                    ...(system ? { systemInstruction: system } : {}),
                    maxOutputTokens: request.maxOutputTokens,
                    // 思考は要約で流してもらう。待っている人に何をしているか見せるため。
                    thinkingConfig: { thinkingLevel: LEVEL[request.reasoningEffort], includeThoughts: true },
                    ...(request.json ? { responseMimeType: "application/json" } : {}),
                    automaticContinuation: false
                }
            });
            // 利用量は塊ごとにそこまでの累計で来る。最後のものを使う。
            for await (const chunk of stream) {
                if (chunk.usageMetadata) usage = chunk.usageMetadata;
                if (chunk.promptFeedback?.blockReason) blocked = chunk.promptFeedback.blockReason;
                const candidate = chunk.candidates?.[0];
                if (!candidate) continue;
                if (candidate.finishReason) finish = candidate.finishReason;
                for (const part of candidate.content?.parts ?? []) {
                    if (!part.text) continue;
                    if (part.thought) {
                        onDelta?.("reasoning", part.text);
                    } else {
                        text += part.text;
                        onDelta?.("content", part.text);
                    }
                }
            }
        } catch (e) {
            throw asProviderError(e);
        }

        // 断られた。同じ頼みで繰り返しても同じなので、再試行にはしない。
        if (blocked) throw new ProviderError(`Gemini が頼みを受け付けなかった（${blocked}）`, "bad-request", "unknown");
        if (finish && REFUSED.includes(finish)) {
            throw new ProviderError(`Gemini が応じなかった（${finish}）`, "bad-request", "unknown");
        }
        if (!usage) throw new ProviderError("Gemini が利用量を返さなかった", "server", "unknown");
        const truncated = finish === FinishReason.MAX_TOKENS || finish === FinishReason.CONTINUATION;
        if (finish !== FinishReason.STOP && !truncated) {
            throw new ProviderError(`Gemini が途中で止まった（${finish ?? "理由なし"}）`, "server", "unknown");
        }
        return { text, usage: this.usage(usage), truncated };
    }

    /**
     * 利用量と費用。Gemini の promptTokenCount はキャッシュ分を含む（DeepSeek の
     * prompt_tokens と同じ意味）ので、そのまま台帳に入れる。candidatesTokenCount は
     * 思考を含まないので、思考を足して出力にする（ほかの事業者と同じ意味にする）。
     */
    private usage(raw: GenerateContentResponseUsageMetadata): Usage {
        const input = raw.promptTokenCount ?? 0;
        const read = raw.cachedContentTokenCount ?? 0;
        const thoughts = raw.thoughtsTokenCount ?? 0;
        const output = (raw.candidatesTokenCount ?? 0) + thoughts;
        const usd = (
            (input - read) * this.price.input
            + read * this.price.cached
            + output * this.price.output
        ) / 1e6;
        return { inputTokens: input, cachedInputTokens: read, outputTokens: output, reasoningTokens: thoughts, usd };
    }
}
