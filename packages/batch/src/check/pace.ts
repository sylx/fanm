// 速さの物差しと、遅いときにAIへ返す言葉。
//
// 実測: 通った作品は1フレーム 0.3ms で走る。実機の 60fps は 16.7ms。
// 毎フレーム画面を描き直す作品はこの百倍以上かかり、検査を走り切れない。

export const PACE = {
    /** これを超えていたら、最後まで走らせずに見切る。 */
    maxMsPerFrame: 20,
    /** 見切る前に、最低これだけは走らせる（最初の数フレームは重いので）。 */
    after: 300
} as const;

/** 進まなくなったとき。遅いのではなく、そのフレームから返ってこない。 */
export function stallAdvice(frame: number, stalledSeconds: number): string {
    return [
        `${frame} フレーム目から処理が返ってこない（そこで ${stalledSeconds.toFixed(0)} 秒以上止まっている）。そこまでは正常な速さで走っていた。`,
        "そのフレームだけで行う処理を見直す。無限ループになっていないか。",
        "while の条件、配列の走査、その回だけ通る分岐を疑う。",
        "そのフレームでしか呼ばない処理（最後の演出、場面の切り替えなど）があれば、そこを見る。"
    ].join("\n");
}

export function slowAdvice(frames: number, reached: number, msPerFrame: number, limitSeconds?: number): string {
    const head = limitSeconds
        ? `${limitSeconds}秒以内に ${frames} フレームを走り切らなかった（${reached} フレームまで）。`
        : `${frames} フレームのうち ${reached} フレームまでで見切った。この速さでは最後まで走らない。`;
    return [
        head,
        `1フレームあたり ${msPerFrame.toFixed(1)}ms かかっている。実機の 60fps は 16.7ms で、通った作品はたいてい 1ms 以下。`,
        "毎フレーム画面全体を描き直していないか見直す。背景は一度だけ描いて残し、動くものはハードウェアスプライトに任せる。",
        "gfx の塗りは V9938 の blitter を1画素ずつ数えて再現するので、大きな矩形や円を毎フレーム積むと現実の時間も食う。",
        "gfx.now はVRAMへ直接書くので、広い範囲に使うとさらに重い。"
    ].join("\n");
}
