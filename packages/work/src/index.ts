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

import type { App, BUTTON, TextStyle } from "fantasy-msx";

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

/**
 * 日本語を出すときの `ctx.text` の書式。
 *
 * 内蔵フォント（`gfx.text`）は ASCII しか持たない。日本語は `ctx.text` で
 * 組む。エンジンに同梱された JF Dot K12x10 というドット面で、ギャラリーでは
 * プレイヤーが先に読み込み、検査では同じ面から取り出したドットを並べる。
 * だから、どちらでも同じ字が出る。
 *
 *     text.style = DOT_STYLE;
 *     text.drawNow(16, 160, "ここはドコダロウ", { color: 15 });
 *
 * ここにある値は、この面が決めているもので、選べるものではない。大きさを
 * 変えるとドットが崩れる。傾けたり太らせたりもできない。
 */
export const DOT_STYLE: TextStyle = {
    font: "'JF Dot K12x10', monospace",
    /** 12 ではない。全角の送りが 1.2em なので、12画素になる大きさが 10。 */
    size: 10,
    /** この面には一つの格子しかない。512画素のモード（G5/G6）では使わない。 */
    stretch: 1,
    /** ドットを画素にそのまま載せる。外すと一行が二行ににじむ。 */
    snap: true,
    /** 行送り。字の高さ 10 に、行間 2。 */
    lineHeight: 12
};

/** DOT_STYLE で組んだときの1字の大きさ。全角はこの幅の2倍。 */
export const DOT_CELL = { width: 6, height: 12 } as const;

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
    /**
     * このコードを書いたAIのモデル名。事業者を増やしても、どの頭が作ったかで
     * 作品を見分けられるように残す。モデル名を記録する前の作品にはない。
     */
    readonly model?: string;
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
