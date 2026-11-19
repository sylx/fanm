// 絵を描く相手（D部門）。文章を書く相手（provider.ts）とは別の口にする。
//
// 描けるのは画像生成の道具を持つ相手だけ（いまは Codex）。書く相手は札束から
// 引くが、描く相手はそれとは別に決める。DeepSeek や Claude が書く作品にも、
// Codex が描いた絵を同梱できる。
//
// 返すのは届いたままの画像のバイト列。画面に合わせて縮め、PNG に直すのは
// paint/normalize.ts の役目。

import type { Usage } from "./provider.js";

/** 縦横比。相手が守るとは限らないので、縮めるときには届いた大きさを使う。 */
export type Aspect = "4:3" | "1:1" | "3:4" | "16:9";

export interface PaintRequest {
    /** 何を描くか。企画が書く。 */
    readonly prompt: string;
    readonly aspect: Aspect;
}

export interface Painting {
    readonly bytes: Uint8Array;
    readonly mime: "image/png" | "image/jpeg";
    readonly usage: Usage;
}

export interface Painter {
    readonly name: string;
    readonly model: string;
    /** 予約に使う最大想定費用（USD）。定額の相手は 0。 */
    estimateMaxUsd(request: PaintRequest): number;
    paint(request: PaintRequest): Promise<Painting>;
}

/** 届いたバイト列の形式。先頭の印で見分ける。 */
export function sniff(bytes: Uint8Array): Painting["mime"] | null {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    return null;
}
