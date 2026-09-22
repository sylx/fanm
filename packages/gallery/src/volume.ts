// 音量のつまみ。目録が持って覚えておき、プレイヤーがその値で鳴らす。
// 両方が同じ換算を使うように、ここにまとめる。

export const VOLUME_KEY = "fanM.volume";
export const MUTED_KEY = "fanM.muted";

/**
 * つまみを右端まで上げたときの増幅率。WebMSX の音源は余裕を大きく取って
 * 混ぜてあり、そのままでは他のサイトの音よりずっと小さい。作品を測ると、
 * 一番大きい瞬間でも割れる手前の 1/4 ほどしか使っていないので、3 倍まで
 * 上げても割れない。
 */
export const MAX_GAIN = 3;

/**
 * 音量のつまみの位置（0〜1）から実際の増幅率へ。耳は大きさを対数で聞くので、
 * つまみの位置そのままだと、上半分ではほとんど変わらず、下の端で急に消える。
 * 二乗にしておくと、つまみの真ん中がおおよそ右端の半分の大きさに聞こえる。
 */
export const gainFor = (level: number) => MAX_GAIN * level * level;

/**
 * 初めての人のつまみの位置。作品の元の大きさ（1 倍）のところ。いきなり
 * 3 倍で鳴らすと驚かせるので、上げるかどうかは聞く人に任せる。
 */
export const DEFAULT_LEVEL = Math.sqrt(1 / MAX_GAIN);

/** 覚えておいたつまみの位置。無いか読めなければ既定の位置。 */
export function parseLevel(saved: string | null): number {
    const level = saved === null ? NaN : Number(saved);
    return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : DEFAULT_LEVEL;
}
