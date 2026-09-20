// APIキーなしでバッチを一周させるための偽物。
//
// 企画には決まった JSON を返す。生成では、一回目はわざと型エラーのあるコードを
// 返し、修正を頼まれたら、頼みに入っていた実例（今回の型のテンプレート）を
// そのまま返す。修正の経路まで通して試せるように。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Completion, CompletionRequest, OnDelta, Provider } from "./provider.js";

const PLAN = {
    title: "FAKE STARS",
    pitch: "テンプレートと同じ、円が一つずつ増えていく作品。バッチの結線確認用。",
    subject: "星空",
    motion: "円が少しずつ増える",
    composition: "画面全体に散らばる",
    structure: "最初から最後まで、円が一つずつ増えるだけ。段階は一つ。",
    sound: "なし",
    msxFeatures: ["blitter"],
    interactive: false,
    durationFrames: 1800
};

const TEMPLATES = "templates";

/** 頼みの文に入っていた実例が、どのテンプレートかを当てる。 */
function templateInPrompt(prompt: string): { work: string; meta: string } {
    for (const id of readdirSync(TEMPLATES)) {
        const work = join(TEMPLATES, id, "work.ts");
        if (!existsSync(work)) continue;
        const source = readFileSync(work, "utf8");
        if (prompt.includes(source.slice(0, 200))) {
            return { work: source, meta: readFileSync(join(TEMPLATES, id, "meta.json"), "utf8") };
        }
    }
    const fallback = join(TEMPLATES, "ambient");
    return {
        work: readFileSync(join(fallback, "work.ts"), "utf8"),
        meta: readFileSync(join(fallback, "meta.json"), "utf8")
    };
}

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

        const prompt = request.messages.map(m => m.content).join("\n");
        const { meta, work: template } = templateInPrompt(prompt);
        let work = template;
        if (this.generations++ === 0) work = work.replace("let frame = 0;", "let frame: string = 0;");
        return {
            text: `できました。\n\n\`\`\`ts work.ts\n${work}\`\`\`\n\n\`\`\`json meta.json\n${meta}\`\`\`\n`,
            usage,
            truncated: false
        };
    }
}
