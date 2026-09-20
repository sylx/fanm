// 実例（templates/<型>/work.ts）の渡し方。
//
// 実例をそのまま見せると、AIは設定だけを変えた写しを返してくる（実測: RPG では
// 生成コードの語の並びの 85% が実例と一致した。名前と敵だけ変えて、あとは同じ）。
// 実例は API の使い方と毎フレームの仕事の少なさを伝えるためのものなので、
// **中身のデータは抜いて渡す**。地図・絵・文章・MML は自分で作ってもらう。
//
// 抜いたあとに、実例の持ち物の名前と文章を「使わない一覧」として渡す。写しに
// なりかけたときに、AIが自分で気づける手がかりになる。

/** 文字列とコメントの中を見ないための走査。括弧の対応を数えるのに使う。 */
function skipQuoted(source: string, i: number): number {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
        for (let j = i + 1; j < source.length; j++) {
            if (source[j] === "\\") j++;
            else if (source[j] === ch) return j + 1;
        }
        return source.length;
    }
    if (ch === "/" && source[i + 1] === "/") {
        const end = source.indexOf("\n", i);
        return end < 0 ? source.length : end;
    }
    if (ch === "/" && source[i + 1] === "*") {
        const end = source.indexOf("*/", i);
        return end < 0 ? source.length : end + 2;
    }
    return i;
}

/**
 * 何行にもわたる配列の中身を落とす。地図、スプライトの絵、点の並び、場面の一覧。
 * 落とした跡には、何を自分で作るのかを書いた注記を残す。
 */
export function thin(source: string, minLines = 3): string {
    let out = "";
    let i = 0;
    while (i < source.length) {
        const skipped = skipQuoted(source, i);
        if (skipped > i) {
            out += source.slice(i, skipped);
            i = skipped;
            continue;
        }
        if (source[i] !== "[") {
            out += source[i++];
            continue;
        }
        // 対応する ] を探す。文字列とコメントの中の括弧は数えない。
        let depth = 0;
        let j = i;
        for (; j < source.length; j++) {
            const q = skipQuoted(source, j);
            if (q > j) { j = q - 1; continue; }
            if (source[j] === "[") depth++;
            else if (source[j] === "]" && --depth === 0) break;
        }
        const body = source.slice(i, Math.min(j + 1, source.length));
        const lines = body.split("\n").length - 1;
        if (lines >= minLines) {
            out += "[ /* 中身は企画に合わせて自分で作る（ここは例の分を省いてある） */ ]";
            i = j + 1;
        } else {
            out += source[i++];
        }
    }
    return out;
}

const KEEP = new Set(["App", "Context", "WorkFactory", "DOT_STYLE", "BUTTON", "create", "init", "update", "draw"]);

/**
 * 実例だけのもの。そのまま使わせないために並べる。
 *
 * - 実例が付けた名前（定数と関数）
 * - 実例の日本語の文章（敵の名前、台詞、表示）
 */
export function avoid(source: string): string[] {
    const names = new Set<string>();
    for (const m of source.matchAll(/(?:const|let|function)\s+([A-Za-z_$][\w$]*)/g)) {
        if (!KEEP.has(m[1]) && m[1].length > 2) names.add(m[1]);
    }
    const words = new Set<string>();
    for (const m of source.matchAll(/["'`]([^"'`\n]*[ぁ-んァ-ヶ一-龠][^"'`\n]*)["'`]/g)) {
        words.add(m[1].trim());
    }
    const list: string[] = [];
    if (names.size) list.push(`例が付けた名前: ${[...names].slice(0, 40).join(", ")}`);
    if (words.size) list.push(`例の文章: ${[...words].slice(0, 30).map(w => `「${w}」`).join(" ")}`);
    return list;
}

/** 生成の頼みに入れる「使わない一覧」。 */
export function avoidBrief(source: string): string {
    const list = avoid(source);
    return list.length ? list.map(l => `- ${l}`).join("\n") : "（なし）";
}
