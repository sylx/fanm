// 作り手のペンネーム。単語を二つ組んで作る。
//
//     deepseek  日本語 + 日本の名前        豪快太郎
//     openai    外来語 + 日本の名前        シャープ一郎
//     claude    英語 + 英語（つなげて書く）  GoldenSnail
//
// 名前は性格の鍵（persona.ts の personaKey）の散らし（hash）で単語を選ぶ。同じ鍵
// なら同じ名前になる。ただ単語の組は千に届かないので、作り手が増えれば散らしは
// いずれぶつかる。ぶつかったら散らし直す。そのとき、どの名前がもう使われているかは
// 作品庫の meta（model / traits / penName）から読む。
//
// 作品庫に出たことのある作り手は、単語の表を書き替えても、作品庫に残った名前を
// 名乗り続ける。名前が決まるのは初めて採用されたときで、その後は作品庫が名前の
// 台帳になる。

import type { ProviderConfig } from "../config.js";
import { personaKey, type Traits } from "./persona.js";

/** 頭の語は緻密↔大雑把で寄せる。緻密な作り手は細い語、大雑把な作り手は太い語。 */
interface Words {
    readonly fine: readonly string[];
    readonly bold: readonly string[];
    readonly tails: readonly string[];
}

const JAPANESE_TAILS = [
    "太郎", "一郎", "次郎", "三郎", "五郎", "丸", "之助", "衛門", "兵衛", "蔵", "吉", "助",
    "平", "介", "彦", "斎", "子", "美", "姫", "坊", "翁", "庵", "堂", "屋"
];

const JAPANESE: Words = {
    fine: [
        "細雪", "精密", "繊細", "端正", "静謐", "綿密", "玲瓏", "清澄", "精緻", "硝子", "螺鈿", "銀糸",
        "蒔絵", "刺繍", "箱庭", "細工", "水晶", "方眼", "墨線", "織目", "切子", "寄木", "象嵌", "金継"
    ],
    bold: [
        "豪快", "剛腕", "疾風", "怒涛", "雷電", "大砲", "爆走", "猛進", "一撃", "豪胆", "大河", "荒波",
        "火山", "竜巻", "鉄拳", "轟音", "旋風", "大胆", "奔放", "痛快", "激流", "巨岩", "山嵐", "大漁"
    ],
    tails: JAPANESE_TAILS
};

const LOANWORD: Words = {
    fine: [
        "シャープ", "ミクロ", "クリスタル", "ピクセル", "シルク", "レース", "グリッド", "プリズム",
        "ミント", "パズル", "ガラス", "ルーペ", "ドット", "ピンセット", "レンズ", "ミニチュア",
        "スケール", "コンパス", "モザイク", "ネオン", "ステッチ", "フィルム", "クローム", "リボン"
    ],
    bold: [
        "ビッグ", "ダイナマイト", "ターボ", "ジャンボ", "マッハ", "ロケット", "サンダー", "ハリケーン",
        "メガトン", "ボルケーノ", "タイフーン", "バズーカ", "ワイルド", "ギガ", "ダッシュ", "ブースト",
        "ハンマー", "スパーク", "ボンバー", "ジェット", "マグナム", "ドラゴン", "タイタン", "ストーム"
    ],
    tails: JAPANESE_TAILS
};

const ENGLISH: Words = {
    fine: [
        "Golden", "Silver", "Crystal", "Velvet", "Ivory", "Amber", "Quiet", "Tiny", "Gentle", "Careful",
        "Pale", "Misty", "Frosted", "Silken", "Needle", "Lace", "Pearl", "Glass", "Hushed", "Dainty",
        "Slender", "Clockwork", "Filigree", "Paper"
    ],
    bold: [
        "Thunder", "Iron", "Wild", "Mighty", "Blazing", "Roaring", "Rocket", "Stormy", "Brave", "Giant",
        "Rusty", "Hasty", "Bold", "Burly", "Rowdy", "Jolly", "Rampant", "Molten", "Heavy", "Loud",
        "Rugged", "Brassy", "Sudden", "Grand"
    ],
    tails: [
        "Snail", "Owl", "Fox", "Heron", "Otter", "Moth", "Badger", "Crane", "Wren", "Lynx", "Mole", "Newt",
        "Finch", "Hare", "Beetle", "Raven", "Toad", "Marten", "Gecko", "Koi", "Yak", "Walrus", "Bison", "Puffin"
    ]
};

/** 事業者ごとの言葉。偽のAIは英語にしておく。 */
const WORDS: Record<ProviderConfig["name"], Words> = {
    deepseek: JAPANESE,
    openai: LOANWORD,
    claude: ENGLISH,
    fake: ENGLISH
};

/**
 * FNV-1a（32bit）に murmur3 の仕上げを掛けたもの。どの環境でも同じ値を返す。
 * FNV-1a だけだと下位の桁が散らず、末尾だけ違う文字列（散らし直しの `#1`, `#2`…）
 * を 24 で割った余りが同じ所を回って、空いている組に辿り着けなかった。
 */
function hash(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; ++i) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

/** 頭の語の候補。真ん中の作り手は両方から選ぶ。 */
function heads(words: Words, traits: Traits): readonly string[] {
    const precision = Number(traits.precision ?? 0.5);
    if (precision < 0.5) return words.fine;
    if (precision > 0.5) return words.bold;
    return [...words.fine, ...words.bold];
}

/** 作品庫に残っている作り手。名前の台帳として読む。 */
export interface KnownAuthor {
    readonly model: string;
    readonly traits: Traits;
    readonly penName: string;
}

/**
 * 作り手の名前。作品庫に同じ作り手がいればその名前、いなければ単語を組んで、
 * 別の作り手が使っている名前を避ける。
 */
export function penName(
    vendor: ProviderConfig["name"],
    model: string,
    traits: Traits,
    known: readonly KnownAuthor[]
): string {
    const key = personaKey(model, traits);
    const taken = new Set<string>();
    for (const author of known) {
        if (personaKey(author.model, author.traits) === key) return author.penName;
        taken.add(author.penName);
    }
    const words = WORDS[vendor];
    const pool = heads(words, traits);
    const compose = (salt: string) =>
        pool[hash(`${key}${salt}/head`) % pool.length] + words.tails[hash(`${key}${salt}/tail`) % words.tails.length];
    const combinations = pool.length * words.tails.length;
    for (let i = 0; i < combinations * 4; ++i) {
        const name = compose(i ? `#${i}` : "");
        if (!taken.has(name)) return name;
    }
    // 組が尽きたら番号を振る。ここまで来るなら単語の表を増やす。
    const base = compose("");
    for (let n = 2; ; ++n) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}
