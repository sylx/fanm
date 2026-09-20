// 頼む相手の札束。ジョブのたびに一人引く。
//
// 型（plan/forms.ts）や縛り（plan/variations.ts）と同じ引き方をする。直近の作品で
// 少ない相手を先に当て、並んだらその中から乱択する。引くのはジョブの種なので、
// 途中で落ちて再開しても同じ相手になる。
//
// 相手が変われば作風が変わる。同じ企画、同じ型、同じ縛りでも、書く頭が違えば
// コードの形が違う。縛りが一つの型の中を散らすのに対して、こちらは型の外側から
// 散らす。
//
// 札には share（引かれやすさ）を書ける。単価は相手ごとに10倍ほど違うので、高い
// 相手は「たまに」にしておける。0 にすると引かれない（消さずに休ませられる）。

import type { ProviderConfig } from "../config.js";
import { Claude, CLAUDE_API_KEY_ENV, CLAUDE_MODELS } from "./claude.js";
import { DeepSeek, DEEPSEEK_API_KEY_ENV, DEEPSEEK_MODELS } from "./deepseek.js";
import { FakeProvider } from "./fake.js";
import type { Provider } from "./provider.js";

/** 偽のAIだけの札束。--fake のときは設定の札束を使わない。 */
export const FAKE_DECK: readonly ProviderConfig[] = [{ name: "fake", model: "fake" }];

const shareOf = (entry: ProviderConfig) => entry.share ?? 1;

/** ログに出す札束。 */
export function deckBrief(deck: readonly ProviderConfig[]): string {
    return deck.map(e => (e.share === undefined ? e.model : `${e.model}×${e.share}`)).join(" / ");
}

/**
 * 今回頼む相手。直近の作品を数え、share で割って足りていない相手を当てる。
 * 札がぜんぶ share 1 なら「少ないものから」になる（pickForm と同じ）。
 *
 * 数えるのは直近 window 作まで。ずっと昔まで数えると、一度偏った分をいつまでも
 * 取り返そうとして、こんどは逆に偏る。
 */
export function drawProvider(
    deck: readonly ProviderConfig[],
    recent: readonly string[],
    random: () => number,
    window = deck.reduce((n, e) => n + shareOf(e), 0) * 3
): ProviderConfig {
    // share 0 は引かない。ぜんぶ 0 なら区別がないので、そのまま全員から引く。
    const playable = deck.filter(e => shareOf(e) > 0);
    const pool = playable.length ? playable : deck;
    const counts = new Map<string, number>();
    for (const model of recent.slice(0, Math.ceil(window))) counts.set(model, (counts.get(model) ?? 0) + 1);
    const deficit = (e: ProviderConfig) => (counts.get(e.model) ?? 0) / (shareOf(e) || 1);
    const fewest = Math.min(...pool.map(deficit));
    const candidates = pool.filter(e => deficit(e) <= fewest + 1e-9);
    return candidates[Math.floor(random() * candidates.length)] ?? pool[0];
}

/**
 * 指定された相手だけの札束。事業者の名前（`claude`）でも、モデル名
 * （`claude-opus-5`）でもよい。名前で指すと、その事業者の札が複数あれば
 * その中から引く。合う札がなければ undefined。
 */
export function deckNamed(deck: readonly ProviderConfig[], wanted: string): readonly ProviderConfig[] | undefined {
    const found = deck.filter(e => e.name === wanted || e.model === wanted);
    return found.length ? found : undefined;
}

/**
 * 単価表に無い相手。鍵が要らないので、手元から本番へ設定を送る前の点検に使う
 * （scripts/conf-push.sh）。verifyDeck は鍵も見るが、そちらは動かす側の話。
 */
export function unknownModels(deck: readonly ProviderConfig[]): string[] {
    const known = (entry: ProviderConfig) =>
        entry.name === "fake" || (entry.name === "claude" ? CLAUDE_MODELS : DEEPSEEK_MODELS).includes(entry.model);
    return deck.filter(e => !known(e)).map(e => `${e.name} / ${e.model}`);
}

/** 札を実際の接続にする。鍵が無ければここで止まる。 */
export function createProvider(entry: ProviderConfig): Provider {
    if (entry.name === "fake") return new FakeProvider(entry.model);
    const env = entry.apiKeyEnv ?? (entry.name === "claude" ? CLAUDE_API_KEY_ENV : DEEPSEEK_API_KEY_ENV);
    const key = process.env[env];
    if (!key) throw new Error(`環境変数 ${env} に APIキーがない（${entry.name} ${entry.model}）`);
    return entry.name === "claude"
        ? new Claude(entry.model, key, entry.baseUrl)
        : new DeepSeek(entry.model, key, entry.baseUrl);
}

/**
 * 札束をひととおり作ってみる。鍵の無い相手や単価表に無いモデルを、制作を始める
 * 前に見つけるため。引かれて初めて止まると、何日も経ってから気づくことになる。
 */
export function verifyDeck(deck: readonly ProviderConfig[]): void {
    for (const entry of deck) createProvider(entry);
}
