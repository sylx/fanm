// 作品の検査をまとめて行い、採否と、AIへ返す所見を出す。
//
//     静的検査 → 型検査 → 束ねて隔離実行・撮影 → 画面の数値で判定
//
// 静かな作品やゆっくり変わる作品は落とさない。落とすのは、明らかに
// 動いていないもの・何も映っていないもの・描画が溜まり続けるものだけ。

import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRandom, type Scenario, type ScenarioInput, type WorkDescription } from "@fanm/work";
import { runIsolated } from "./isolated.js";
import { slowAdvice } from "./pace.js";
import type { RunnerCapture } from "./runner.js";
import { staticCheck } from "./static.js";
import { typecheck } from "./typecheck.js";

export interface CheckReport {
    readonly ok: boolean;
    readonly stage: "static" | "typecheck" | "build" | "timeout" | "crash" | "runtime" | "screen" | "passed";
    /** AIへそのまま返せる、失敗の理由。 */
    readonly problems: readonly string[];
    /** 画面の様子の文章。成否にかかわらず付ける。 */
    readonly observations: string;
    readonly captures: readonly RunnerCapture[];
    /** サムネイルに使う撮影。 */
    readonly thumbnail?: string;
    readonly scenario: Scenario;
}

export const MIN_FRAMES = 1800;
export const MAX_FRAMES = 3600;

/** 検査で押すボタン。十字と2つのトリガだけ。キーボードは作品に使わせない。 */
const BUTTONS = ["UP", "DOWN", "LEFT", "RIGHT", "A", "B"] as const;

/**
 * 操作できる作品を、実際に操作してみる入力。
 *
 * 誰かが遊ぶところを真似るのではなく、入力を受ける道を一度は通すためのもの。
 * 操作で落ちる作品、押しっぱなしで壊れる作品を、公開の前に見つける。
 *
 * 最初の `QUIET` フレームは何も押さない。ルールが「操作を待たずに見どころまで
 * 進む」ことを求めているので、まずそこが動くのを見る。以後は押して離すを
 * 繰り返す。seed から作った乱数なので、同じ作品には毎回同じ操作が届く。
 */
function inputsFor(frames: number, seed: number): ScenarioInput[] {
    const QUIET = 600;                       // 10秒は無操作のまま見る
    const random = createRandom(seed ^ 0x5eed);
    const inputs: ScenarioInput[] = [];
    for (let frame = QUIET; frame < frames - 60; frame += 24 + Math.floor(random() * 36)) {
        const code = BUTTONS[Math.floor(random() * BUTTONS.length)];
        const held = 6 + Math.floor(random() * 30);
        inputs.push({ frame, kind: "button", code, down: true });
        inputs.push({ frame: Math.min(frames - 1, frame + held), kind: "button", code, down: false });
    }
    return inputs;
}

export function scenarioFor(meta: WorkDescription, seed: number): Scenario {
    const frames = Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.round(meta.durationFrames || MIN_FRAMES)));
    const captures = [30, Math.floor(frames / 4), Math.floor(frames / 2), Math.floor(frames * 3 / 4), frames - 1];
    // 操作方法が書いてある作品は、操作できるはずのもの。押してみる。
    const inputs = meta.controls?.trim() ? inputsFor(frames, seed) : [];
    return { seed, frames, captures, inputs };
}

function describe(captures: readonly RunnerCapture[], scenario: Scenario): string {
    if (!captures.length) return "撮影できた画面はない。";
    const played = scenario.inputs.length
        ? `\n（${(scenario.inputs[0].frame / 60).toFixed(0)}秒目から、十字とトリガを`
            + `${scenario.inputs.length / 2}回、でたらめに押しながら動かした）`
        : "";
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    return captures.map(c => {
        const s = c.stats;
        const parts = [
            `${c.frame}フレーム目（${(c.frame / 60).toFixed(1)}秒）: ${s.colors}色`,
            `最も多い色が画面の${pct(s.dominant)}`,
            s.changed === null ? null : `前の撮影から${pct(s.changed)}の画素が変化`,
            `描画待ち${c.pending}件`,
            c.musicPlaying ? "BGMあり" : "BGMなし"
        ];
        return `- ${parts.filter(Boolean).join("、")}`;
    }).join("\n") + played;
}

const ROOT = resolve(import.meta.dirname, "../../../..");

/** スタックトレースを、AIが読める短さと相対パスにする。 */
function tidy(error: string, dir: string): string {
    return error
        .replaceAll(`${resolve(dir)}/`, "")
        .replaceAll(`${ROOT}/engine/fantasy-msx/`, "fantasy-msx/")
        .replaceAll(`${ROOT}/`, "")
        .split("\n")
        .slice(0, 12)
        .join("\n");
}

/** 画面の数値から、明らかな不具合だけを拾う。 */
function judgeScreen(captures: readonly RunnerCapture[]): string[] {
    const problems: string[] = [];
    // 星空のように地の色が広い作品は正常。落とすのは本当に何も無いときだけ。
    if (captures.every(c => c.stats.colors <= 2 || c.stats.dominant > 0.9995)) {
        problems.push("どの時点でも画面がほぼ一色のまま。何も描かれていないように見える。");
    }
    const later = captures.slice(1);
    if (later.length && later.every(c => c.stats.changed === 0) && captures.every(c => !c.musicPlaying)) {
        problems.push("最初の撮影以降、画面が一度も変化せず、音も鳴っていない。止まっているように見える。");
    }
    const pending = captures.map(c => c.pending);
    const last = pending[pending.length - 1] ?? 0;
    if (last > 200 && pending.every((p, i) => i === 0 || p >= pending[i - 1])) {
        problems.push(`描画待ちが増え続けている（最後は${last}件）。blitter の速さを超えて描画を積んでいる。gfx.pending を見て積むのを控える。`);
    }
    return problems;
}

export async function checkWork(dir: string, seed: number): Promise<CheckReport> {
    const workPath = join(dir, "work.ts");
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as WorkDescription;
    const scenario = scenarioFor(meta, seed);
    const fail = (stage: CheckReport["stage"], problems: string[], captures: readonly RunnerCapture[] = [], observations = ""): CheckReport =>
        ({ ok: false, stage, problems, observations, captures, scenario });

    const lint = staticCheck(readFileSync(workPath, "utf8"));
    if (lint.length) return fail("static", lint);

    const types = await typecheck(workPath);
    if (types.length) return fail("typecheck", types);

    const out = join(dir, "check");
    mkdirSync(out, { recursive: true });
    const run = await runIsolated(workPath, scenario, out, { timeoutMs: 120_000, maxHeapMb: 512 });
    if (run.stage !== "run") return fail(run.stage, [run.error]);

    const { result } = run;
    const observations = describe(result.captures, scenario);
    if (result.slow) {
        return fail("timeout", [slowAdvice(scenario.frames, result.errorFrame ?? 0, result.msPerFrame)], result.captures, observations);
    }
    if (!result.ok) {
        return fail("runtime", [`${result.errorFrame ?? 0}フレーム目で例外:\n${tidy(result.error ?? "", dir)}`], result.captures, observations);
    }
    const screen = judgeScreen(result.captures);
    if (screen.length) return fail("screen", screen, result.captures, observations);

    const candidates = result.captures.slice(Math.floor(result.captures.length / 2));
    const thumbnail = candidates.reduce((best, c) => c.stats.colors > best.stats.colors ? c : best, candidates[0]);
    return {
        ok: true, stage: "passed", problems: [], observations,
        captures: result.captures, thumbnail: join(out, thumbnail.file), scenario
    };
}
