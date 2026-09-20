// いつ次の制作を始めるか。残予算と残日数から頻度を決める。
//
// 月の前半で使い切らないように、「残りいくら」を「残り何日」で割って一日あたりの
// 回数を出し、設定の上限と低い方を採る。実測の一作品あたりの費用が分かってくると、
// 頻度はそれに追従する（安く済むモデルなら自然と回数が増える）。
//
// 停止中の予定は取り戻さない。長く止まっていても、再開後に走るのは一回分だけで、
// そこから改めて間隔を数える。

const DAY = 86_400_000;

/** 実測がまだないときに見込む一作品あたりの費用。作品予算の1/4。 */
export const UNKNOWN_COST_RATIO = 0.25;

export interface SchedulerInput {
    readonly now: Date;
    /** 最後に制作を始めた時刻。まだ一度もなければ undefined。 */
    readonly lastAttemptAt?: string;
    /** 今月の残り（USD）。予約分を引いたもの。 */
    readonly remainingUsd: number;
    /** 一回の制作にかかる見込み（USD）。実測があればそれを渡す。 */
    readonly costPerAttemptUsd: number;
    /** 設定した一日あたりの上限（回）。 */
    readonly maxAttemptsPerDay: number;
}

export interface SchedulerDecision {
    /** 次に制作を始めてよい時刻。 */
    readonly next: Date;
    /** 予算切れなどで止めている理由。 */
    readonly paused?: string;
    /** 決めた頻度（回/日）。 */
    readonly attemptsPerDay: number;
    /** 決め方の説明。ログに出す。 */
    readonly reason: string;
}

/** 翌月の始まり。台帳が月をUTCで区切るので、ここも合わせる。 */
export function nextMonth(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export function decide(input: SchedulerInput): SchedulerDecision {
    const { now, remainingUsd, costPerAttemptUsd, maxAttemptsPerDay } = input;
    const end = nextMonth(now);
    // 月末ぎりぎりに残りを一気に使わない。残り時間は最低でも1時間分として数える。
    const daysLeft = Math.max((end.getTime() - now.getTime()) / DAY, 1 / 24);
    const money = `残り $${remainingUsd.toFixed(2)}、あと ${daysLeft.toFixed(1)}日、一作品 $${costPerAttemptUsd.toFixed(3)} 見込み`;

    if (remainingUsd <= 0) {
        return { next: end, paused: "月間予算を使い切った。翌月まで待つ", attemptsPerDay: 0, reason: money };
    }
    // 一作品分も残っていないなら、始めても途中で予算に当たって止まるだけ。
    if (remainingUsd < costPerAttemptUsd) {
        return { next: end, paused: "残りが一作品分に足りない。翌月まで待つ", attemptsPerDay: 0, reason: money };
    }

    const affordable = remainingUsd / (costPerAttemptUsd * daysLeft);
    const attemptsPerDay = Math.min(maxAttemptsPerDay, affordable);
    const interval = DAY / attemptsPerDay;
    const reason = `${money} → 一日 ${affordable.toFixed(1)} 回まで出せる（設定の上限 ${maxAttemptsPerDay} 回）。${(interval / 3_600_000).toFixed(1)}時間おきに作る`;

    // 一度も作っていなければすぐ始める。間隔が過ぎていても、取り戻さず一回分だけ。
    const last = input.lastAttemptAt ? Date.parse(input.lastAttemptAt) : undefined;
    const next = last === undefined ? now : new Date(Math.max(last + interval, now.getTime()));

    // 間隔が月をまたいだ。翌月には予算が戻るので、そこで再開する。
    // 予算が薄くて間隔が一日を超えているなら「休んでいる」、月末に当たっただけなら普通の待ち。
    if (next.getTime() > end.getTime()) {
        return { next: end, paused: interval > DAY ? "残予算が少ないので翌月まで待つ" : undefined, attemptsPerDay, reason };
    }
    return { next, attemptsPerDay, reason };
}
