// 知らせを送る。道は二つある。
//
//     tell  人を呼ぶ。放っておいても直らないこと（鍵切れ、権限不足、何度やっても
//           同じ失敗）だけ。日常の失敗では呼ばない。同じ用件は間引く
//     say   伝えるだけ。作品が出たときなど。覚え書きにも残さず、間引きもしない
//
// 知らせ先は環境変数 FANM_NOTIFY_WEBHOOK。Discord でも Slack でも受けられるよう、
// content と text の両方を入れた JSON を送る。設定がなければログと <VAR>/run.json
// に残すだけで、それも立派な知らせ（fanm status が拾う）。

import type { Log } from "./log.js";
import type { StateStore } from "./state.js";

/** 同じことを知らせ直すまでの間隔。 */
const REPEAT_MS = 6 * 3_600_000;

export class Notifier {
    constructor(
        private readonly store: StateStore,
        private readonly log: Log,
        private readonly url = process.env.FANM_NOTIFY_WEBHOOK
    ) {}

    /** 人の対応が要る問題。同じ key は REPEAT_MS の間、鳴らし直さない。 */
    async tell(key: string, message: string): Promise<void> {
        const now = new Date();
        this.store.change(s => { s.attention = { key, message, at: now.toISOString() }; });

        const last = this.store.state.notified[key];
        if (last && now.getTime() - Date.parse(last) < REPEAT_MS) return;
        this.store.change(s => { s.notified[key] = now.toISOString(); });
        this.log.line(`人の対応が必要: ${message}`);
        await this.send(`fanM: ${message}`);
    }

    /** 伝えるだけ。届かなくても制作は続く。 */
    async say(message: string): Promise<void> {
        await this.send(`fanM: ${message}`);
    }

    /** 直った。次に同じことが起きたらまた知らせる。 */
    clear(key: string): void {
        if (this.store.state.attention?.key !== key && !this.store.state.notified[key]) return;
        this.store.change(s => {
            if (s.attention?.key === key) delete s.attention;
            delete s.notified[key];
        });
    }

    private async send(text: string): Promise<void> {
        if (!this.url) return;
        try {
            const response = await fetch(this.url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ content: text, text }),
                signal: AbortSignal.timeout(10_000)
            });
            if (!response.ok) this.log.line(`知らせを送れなかった（HTTP ${response.status}）`);
        } catch (e) {
            // 知らせが届かないこと自体で制作を止めない。
            this.log.line(`知らせを送れなかった: ${(e as Error).message}`);
        }
    }
}
