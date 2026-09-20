// APIキーなしでバッチを一周させるための偽物。
//
// 企画には決まった JSON を返す。生成では、一回目はわざと型エラーのある
// コードを返し、修正を頼まれたら templates/minimal をそのまま返す。
// 修正の経路まで通して試せるように。

import { readFileSync } from "node:fs";
import type { Completion, CompletionRequest, OnDelta, Provider } from "./provider.js";

const PLAN = {
    title: "FAKE STARS",
    pitch: "テンプレートと同じ、円が一つずつ増えていく作品。バッチの結線確認用。",
    subject: "星空",
    motion: "円が少しずつ増える",
    composition: "画面全体に散らばる",
    sound: "なし",
    msxFeatures: ["blitter"],
    interactive: false,
    durationFrames: 1800
};

export class FakeProvider implements Provider {
    readonly name = "fake";
    readonly model = "fake";
    private generations = 0;

    estimateMaxUsd(): number {
        return 0.01;
    }

    estimatePartialUsd(): number {
        return 0.001;
    }

    async complete(request: CompletionRequest, onDelta?: OnDelta): Promise<Completion> {
        onDelta?.("reasoning", "（偽のAIなので考えていない）");
        const usage = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500, reasoningTokens: 0, usd: 0.001 };
        if (request.json) return { text: JSON.stringify(PLAN), usage, truncated: false };

        const meta = readFileSync("templates/minimal/meta.json", "utf8");
        let work = readFileSync("templates/minimal/work.ts", "utf8");
        if (this.generations++ === 0) work = work.replace("let frame = 0;", "let frame: string = 0;");
        return {
            text: `できました。\n\n\`\`\`ts work.ts\n${work}\`\`\`\n\n\`\`\`json meta.json\n${meta}\`\`\`\n`,
            usage,
            truncated: false
        };
    }
}
