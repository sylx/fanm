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

import type { App, BUTTON, RgbaImage, TextStyle } from "fantasy-msx";

/**
 * 作品に同梱した画像の一枚。色は減らしていない（RGBA）。
 *
 * 作品は画像を自分では読みに行けない（fetch も image.load も使えない）。
 * 検査ではヘッドレスのエンジンが同期でフレームを進めるので、Promise は
 * 撮影が終わるまで解決しない。だから、検査ならバッチが、ギャラリーなら
 * プレイヤーが、起動の前に読んでおいて env.images で渡す。作品はそれを
 * ctx.image.palette / reduce に掛け、drawNow で VRAM に置く。
 *
 *     const picture = ctx.image.reduce(env.images.castle, { width: 256, height: 212, fit: "cover", dither: "ordered" });
 *     ctx.image.drawNow(picture);
 */
export type WorkImage = RgbaImage;

/** 画像の名前。`images/<名前>.png` に置き、`env.images.<名前>` で受け取る。 */
export const IMAGE_NAME = /^[a-z][a-z0-9_]{0,31}$/;

export interface WorkEnv {
    /** この再生の乱数seed。検証時と公開時で同じ値を渡せば同じ絵になる。 */
    readonly seed: number;
    /** seed から作った乱数。Math.random の代わりに使う。 */
    readonly random: () => number;
    /**
     * 作品に同梱した画像。名前 → 画素。画像を持たない作品では空。
     * 無い名前を引くと、あるものの一覧を付けて例外を投げる。
     */
    readonly images: Readonly<Record<string, WorkImage>>;
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
    /**
     * 作り手のペンネーム。同じモデルで同じ性格なら同じ名前（batch の persona/）。
     * 性格を持たせる前の作品にはない。
     */
    readonly penName?: string;
    /** 作り手の性格。軸の id → 値。軸が増える前の作品には、新しい軸の値がない。 */
    readonly traits?: Readonly<Record<string, number | string>>;
    readonly seed: number;
    readonly thumbnail: string;
    /**
     * 同梱した画像の名前。ファイルは作品の隣の `images/<名前>.png`。
     * プレイヤーはこれを読んでから作品を起動する。画像の無い作品にはない。
     */
    readonly images?: readonly string[];
    /**
     * シーズンの外の部門の作品なら、その名前（いまは "d" だけ）。ギャラリーは
     * 「D部門」と出す。型（シーズンの作品）の作品にはない。
     */
    readonly department?: string;
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

export function createEnv(seed: number, images: Readonly<Record<string, WorkImage>> = {}): WorkEnv {
    return { seed, random: createRandom(seed), images: guardImages(images) };
}

/**
 * 無い名前を引いたら、その場で分かるようにする。素通しにすると undefined が
 * reduce の奥まで届き、「width を読めない」という手掛かりの無い例外になる。
 * 検査の所見はそのまま AI へ返るので、名前の取り違えだと読める文にしておく。
 */
function guardImages(images: Readonly<Record<string, WorkImage>>): Readonly<Record<string, WorkImage>> {
    const names = Object.keys(images);
    return new Proxy(Object.freeze({ ...images }), {
        get(target, key, receiver) {
            if (typeof key !== "string" || Object.hasOwn(target, key) || key in Object.prototype || key === "then" || key === "toJSON") {
                return Reflect.get(target, key, receiver);
            }
            throw new Error(names.length
                ? `env.images.${key} は無い。同梱している画像は ${names.join(", ")}`
                : `env.images.${key} は無い。この作品は画像を同梱していない`);
        }
    });
}
