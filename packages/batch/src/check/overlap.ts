// コードの重なり。実例（templates/<型>/work.ts）や過去作を、名前だけ変えて
// そのまま持ってきていないかを数で見る。
//
// 二つの数を出す。
//
//     text   そのままの語の並びがどれだけ一致するか。書き写しを見つける。
//     shape  名前・数・文字列を伏せた並びがどれだけ一致するか。同じ作法で書けば自然に
//            上がるので、採否には使わない（実測: 別々に作った RPG 同士でも 0.69、
//            名前だけ変えた写しは 0.86 で、境目が近すぎる）。人が様子を見るための数。
//
// どちらも「作った側のうち、相手にもある割合」（含有率）で、Jaccard ではない。
// 実例は長さが違うので、割合の分母は作った側に取る。

const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\S/g;

/** 伏せない語。構文と、この基盤の呼び名。ここが残るので並びの意味が保たれる。 */
const KEEP = new Set([
    "const", "let", "var", "function", "return", "if", "else", "for", "while", "switch", "case", "break",
    "continue", "new", "class", "this", "typeof", "in", "of", "import", "export", "default", "from",
    "true", "false", "null", "undefined", "void", "type", "interface", "readonly", "as", "Math",
    "ctx", "env", "gfx", "screen", "sprites", "input", "bgm", "text", "now", "frame", "random"
]);

function words(source: string): string[] {
    return source.replace(COMMENTS, " ").match(TOKEN) ?? [];
}

/** 名前・数・文字列を伏せる。並びだけを残す。 */
function blind(word: string): string {
    if (/^["'`]/.test(word)) return "s";
    if (/^\d/.test(word)) return "0";
    if (/^[A-Za-z_$]/.test(word)) return KEEP.has(word) ? word : "x";
    return word;
}

function shingles(words: readonly string[], n: number): Set<string> {
    const set = new Set<string>();
    for (let i = 0; i + n <= words.length; i++) set.add(words.slice(i, i + n).join(" "));
    return set;
}

/** mine のうち、theirs にもある割合。0〜1。 */
function contained(mine: Set<string>, theirs: Set<string>): number {
    if (!mine.size) return 0;
    let hit = 0;
    for (const s of mine) if (theirs.has(s)) hit++;
    return hit / mine.size;
}

/**
 * 書き写しの上限。実例や過去作と、語の並びがこれ以上一致していたら作り直させる。
 *
 * 実測（2026-09）: 別の型のコード同士は text 0.05〜0.19。名前だけ変えた写しは 0.85。
 * 同じ型で作法をそろえれば 0.2 前後までは自然に一致するので、0.35 を境にする。
 */
export const DEFAULT_MAX_OVERLAP = 0.35;


export interface Overlap {
    readonly text: number;
    readonly shape: number;
}

/** 作ったコードが、相手のコードをどれだけそのまま含んでいるか。 */
export function overlap(mine: string, theirs: string, n = 8): Overlap {
    const a = words(mine);
    const b = words(theirs);
    return {
        text: contained(shingles(a, n), shingles(b, n)),
        shape: contained(shingles(a.map(blind), n), shingles(b.map(blind), n))
    };
}
