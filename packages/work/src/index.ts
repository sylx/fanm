// 作品の共通形式。
//
// 一作品は次の二つでできている。
//
//     work.ts    export default (env: WorkEnv) => App    — AIが書くコード
//     meta.json  WorkMeta                                 — AIが書く説明と、バッチが書く記録
//
// 作品は起動のたびに状態を作り直せなければならない。だから App を直接
// エクスポートせず、env を受け取って App を返す関数にする。時刻は
// ctx.frame などのフレーム基準、乱数は env.random だけを使う。

import type { App, BUTTON } from "fantasy-msx";

export interface WorkEnv {
    /** この再生の乱数seed。検証時と公開時で同じ値を渡せば同じ絵になる。 */
    readonly seed: number;
    /** seed から作った乱数。Math.random の代わりに使う。 */
    readonly random: () => number;
}

export type WorkFactory = (env: WorkEnv) => App;

/** AIが企画・生成時に書く部分。 */
export interface WorkDescription {
    readonly title: string;
    readonly description: string;
    /** 操作できない作品では空文字。 */
    readonly controls: string;
    /** 無操作で見どころまで進むのにかかるフレーム数（60fps）。 */
    readonly durationFrames: number;
}

/** 検証時に使った入力と撮影タイミング。公開後も再現できるよう保存する。 */
export interface Scenario {
    readonly seed: number;
    readonly frames: number;
    /** 撮影するフレーム番号。 */
    readonly captures: readonly number[];
    readonly inputs: readonly ScenarioInput[];
}

export type ScenarioInput =
    | { readonly frame: number; readonly kind: "button"; readonly code: keyof typeof BUTTON; readonly down: boolean }
    | { readonly frame: number; readonly kind: "key"; readonly code: string; readonly down: boolean };

/** 公開される作品情報。認証情報・内部ログ・費用はここに入れない。 */
export interface WorkMeta extends WorkDescription {
    readonly id: string;
    readonly createdAt: string;
    /** fantasy-msx のコミット。公開サイトはこれに合うエンジンで再生する。 */
    readonly engine: string;
    readonly seed: number;
    readonly thumbnail: string;
}

/** mulberry32。小さく、どの環境でも同じ列を返す。 */
export function createRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function createEnv(seed: number): WorkEnv {
    return { seed, random: createRandom(seed) };
}
