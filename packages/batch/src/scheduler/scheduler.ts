// いつ次の制作を始めるか。残予算と残日数から頻度を決める。
// 停止中の予定は取り戻さない: 起動直後に大量生成しない。
//
// TODO: 実装。

export interface SchedulerDecision {
    /** 次に制作を始めてよい時刻。 */
    readonly next: Date;
    /** 予算切れなどで止めている理由。 */
    readonly paused?: string;
}
