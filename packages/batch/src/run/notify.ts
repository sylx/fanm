// 知らせを送る。道は二つある。
//
//     tell  人を呼ぶ。放っておいても直らないこと（鍵切れ、権限不足、何度やっても
//           同じ失敗）だけ。日常の失敗では呼ばない。同じ用件は間引く
//     say   伝えるだけ。作品が出たときなど。覚え書きにも残さず、間引きもしない
//
// 知らせ先は環境変数 FANM_NOTIFY_WEBHOOK。送り先は Discord と決めているので、
// embed で送る。題を押せば作品が開き、サムネイルはURLではなく絵として出る。
// 設定がなければログと <VAR>/run.json に残すだけで、それも立派な知らせ
// （fanm status が拾う）。
//
// 一行で読める用件は content に、中身は embed に置く。携帯の通知に出るのは
// content なので、そこだけで「見に行くかどうか」が決まるようにする。

import type { Log } from "./log.js";
import type { StateStore } from "./state.js";

/** 同じことを知らせ直すまでの間隔。 */
const REPEAT_MS = 6 * 3_600_000;

/** Discord が受け取る上限。超えると丸ごと断られるので、こちらで詰める。 */
const LIMIT = { content: 2000, title: 256, description: 4096, field: 1024, footer: 2048, embeds: 10 } as const;

/** 帯の色。ギャラリーの配色から。 */
export const COLOR = {
    /** 作品の知らせ。プレイヤーの「CRT」と同じ緑。 */
    work: 0x3f8a60,
    /** 人を呼ぶとき。 */
    attention: 0xdd6666
} as const;

/** Discord の embed。使うところだけ。 */
export interface Embed {
    readonly title?: string;
    /** 題を押したときに開く場所。 */
    readonly url?: string;
    readonly description?: string;
    readonly color?: number;
    readonly timestamp?: string;
    /** 大きく出す絵。 */
    readonly image?: { readonly url: string };
    /** 右上に小さく添える絵。 */
    readonly thumbnail?: { readonly url: string };
    readonly fields?: readonly { readonly name: string; readonly value: string; readonly inline?: boolean }[];
    readonly footer?: { readonly text: string };
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 上限に収める。AIが書いた題や説明がどれだけ長くても、送れる形にして出す。 */
function fit(embed: Embed): Embed {
    return {
        ...embed,
        ...(embed.title === undefined ? {} : { title: clip(embed.title, LIMIT.title) }),
        ...(embed.description === undefined ? {} : { description: clip(embed.description, LIMIT.description) }),
        ...(embed.fields === undefined ? {} : {
            fields: embed.fields.map(f => ({ ...f, value: clip(f.value, LIMIT.field) }))
        }),
        ...(embed.footer === undefined ? {} : { footer: { text: clip(embed.footer.text, LIMIT.footer) } })
    };
}

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
        await this.send("⚠️ 人の対応が必要", [{
            title: "人の対応が必要",
            description: message,
            color: COLOR.attention,
            timestamp: now.toISOString(),
            footer: { text: key }
        }]);
    }

    /** 伝えるだけ。届かなくても制作は続く。 */
    async say(content: string, embeds?: readonly Embed[]): Promise<void> {
        await this.send(content, embeds);
    }

    /** 直った。次に同じことが起きたらまた知らせる。 */
    clear(key: string): void {
        if (this.store.state.attention?.key !== key && !this.store.state.notified[key]) return;
        this.store.change(s => {
            if (s.attention?.key === key) delete s.attention;
            delete s.notified[key];
        });
    }

    private async send(content: string, embeds?: readonly Embed[]): Promise<void> {
        if (!this.url) {
            this.log.line(`知らせ先がないので送らない: ${content}`);
            return;
        }
        const body = {
            username: "fanM",
            content: clip(content, LIMIT.content),
            embeds: (embeds ?? []).slice(0, LIMIT.embeds).map(fit)
        };
        try {
            const response = await fetch(this.url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(10_000)
            });
            // 断られた理由は本文にある（embed の作りが悪いと 400 で返る）。次も同じなら直せるよう残す。
            if (!response.ok) this.log.line(`知らせを送れなかった（HTTP ${response.status}）: ${clip(await response.text(), 300)}`);
        } catch (e) {
            // 知らせが届かないこと自体で制作を止めない。
            this.log.line(`知らせを送れなかった: ${(e as Error).message}`);
        }
    }
}
