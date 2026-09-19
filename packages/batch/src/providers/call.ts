// 予算を通してAIを呼ぶ。バッチからAIを呼ぶ道はこれ一つだけにする。
//
// 予約 → 呼出し → 精算。一時的な失敗は間隔を延ばしながら上限付きで再試行し、
// 再試行のたびに予約し直す。

import type { Ledger } from "../budget/ledger.js";
import type { Completion, CompletionRequest, OnDelta, Provider } from "./provider.js";
import { ProviderError } from "./provider.js";

const RETRY_DELAYS_MS = [30_000, 120_000, 480_000];

export interface CallLog {
    readonly purpose: string;
    readonly at: string;
    readonly usd: number;
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly truncated: boolean;
}

export async function call(
    provider: Provider,
    ledger: Ledger,
    jobId: string,
    purpose: string,
    request: CompletionRequest,
    onDelta?: OnDelta,
    wait: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
): Promise<Completion & { log: CallLog }> {
    for (let attempt = 0; ; ++attempt) {
        const entry = ledger.reserve(jobId, purpose, provider.estimateMaxUsd(request));
        try {
            const result = await provider.complete(request, onDelta);
            const { usage } = result;
            ledger.settle(entry, usage.usd, {
                input: usage.inputTokens, cached: usage.cachedInputTokens,
                output: usage.outputTokens, reasoning: usage.reasoningTokens
            });
            return {
                ...result,
                log: { purpose, at: entry.at, ...usage, truncated: result.truncated }
            };
        } catch (e) {
            if (e instanceof ProviderError && e.billed === false) ledger.settle(entry, 0);
            else ledger.settleUnknown(entry);
            if (!(e instanceof ProviderError) || !e.retryable || attempt >= RETRY_DELAYS_MS.length) throw e;
            console.warn(`${purpose}: ${e.message} — ${RETRY_DELAYS_MS[attempt] / 1000}秒後に再試行`);
            await wait(RETRY_DELAYS_MS[attempt]);
        }
    }
}
