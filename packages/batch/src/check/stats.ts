// 撮影した画面の数値。DeepSeek V4 Pro は画像を読めないので、画面の様子は
// この数値を文章にして渡す。明らかに何も映っていない作品の判定にも使う。

export interface ImageStats {
    /** 使われている色の数。 */
    readonly colors: number;
    /** 最も多い色が占める割合（0〜1）。 */
    readonly dominant: number;
    /** 前の撮影から変わった画素の割合（0〜1）。最初の撮影では null。 */
    readonly changed: number | null;
}

export function measure(pixels: Uint32Array, previous?: Uint32Array): ImageStats {
    const counts = new Map<number, number>();
    for (const p of pixels) counts.set(p, (counts.get(p) ?? 0) + 1);
    let top = 0;
    for (const n of counts.values()) top = Math.max(top, n);

    let changed: number | null = null;
    if (previous && previous.length === pixels.length) {
        let n = 0;
        for (let i = 0; i < pixels.length; ++i) if (pixels[i] !== previous[i]) ++n;
        changed = n / pixels.length;
    }
    return { colors: counts.size, dominant: top / pixels.length, changed };
}
