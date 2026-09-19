// 予算台帳。すべてのAPI呼出しは、呼ぶ前に最大想定費用を予約し、
// 終わってから実際の利用量で精算する。台帳は var/ledger に永続化し、
// 再起動しても使用額を忘れない。
//
// TODO: 実装。請求の有無が不明な失敗は、予約額のまま確定させる。

export interface Reservation {
    readonly id: string;
    readonly jobId: string;
    /** 予約した最大額（USD）。 */
    readonly maxUsd: number;
}

export interface Ledger {
    /** 月間上限・作品上限を超えるなら null を返し、呼出しを止める。 */
    reserve(jobId: string, maxUsd: number): Reservation | null;
    settle(reservation: Reservation, actualUsd: number): void;
    /** 請求されたか分からない失敗。予約額で確定する。 */
    settleUnknown(reservation: Reservation): void;
    spentThisMonth(): number;
}
