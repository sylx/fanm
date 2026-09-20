// 生成コードの静的検査。prompts/rules.md の禁止事項のうち、文字列で見分けられるもの。
// 隔離実行の前の第一の壁であり、ルール違反をAIへ具体的に返すためのもの。

const ALLOWED_IMPORTS = new Set(["fantasy-msx", "@fanm/work"]);

const FORBIDDEN: readonly [RegExp, string][] = [
    [/\bMath\.random\b/, "Math.random は使わない。env.random を使う"],
    [/\bDate\b/, "Date は使わない。時刻はフレームで数える"],
    [/\bperformance\b/, "performance は使わない。時刻はフレームで数える"],
    [/\bset(Timeout|Interval)\b|\brequestAnimationFrame\b/, "タイマーは使わない。update が毎フレーム呼ばれる"],
    [/\bfetch\b|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/, "外部と通信しない"],
    [/\b(eval|Function)\s*\(/, "eval / Function は使わない"],
    [/\bimport\s*\(/, "動的 import は使わない"],
    [/\brequire\s*\(/, "require は使わない"],
    [/\b(process|globalThis|window|document|self|navigator|localStorage|sessionStorage|indexedDB)\b/, "ホストの環境には触れない"],
    [/\b(ctx|context)\.(image|console|ime|keyboard|crt)\b|\bbios\.(image|console|ime)\b/, "画像・文字盤・日本語入力・CRT の機能は使わない"],
    [/\btext\.(load|ready)\s*\(/, "text.load / text.ready は使わない。ドット面はプレイヤーが先に読んでいる"]
];

/** コメントと文字列を空白にして、そこに書かれた単語で誤検出しないようにする。 */
function stripCommentsAndStrings(source: string): string {
    return source.replace(
        /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g,
        m => m.replace(/[^\n]/g, " ")
    );
}

export function staticCheck(source: string): string[] {
    const problems: string[] = [];
    for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g)) {
        const name = match[1] ?? match[2];
        if (!ALLOWED_IMPORTS.has(name)) problems.push(`import "${name}" は使えない。使えるのは fantasy-msx と @fanm/work だけ`);
    }
    const code = stripCommentsAndStrings(source);
    const lines = code.split("\n");
    for (const [pattern, reason] of FORBIDDEN) {
        const line = lines.findIndex(l => pattern.test(l));
        if (line >= 0) problems.push(`${line + 1}行目: ${reason}`);
    }
    if (!/\bexport\s+default\b/.test(code)) problems.push("default export がない。WorkFactory を default export する");
    return problems;
}
