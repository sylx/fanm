// ヘッドレスでの ctx.text。ホストのフォントの代わりに、取り出しておいた
// ドットを並べる。
//
// ブラウザでは ctx.text が JF Dot K12x10 をそのまま組む。node には組む相手が
// いないので、エンジンは text.rasteriser という差し替え口を空けてある。ここは
// その口に差すもので、dot-font.ts（同じ woff2 から取り出したドット）を並べる。
// だから検査で見える字と、ギャラリーで見える字が同じになる。
//
// 寸法はこの面が決めているもので、選べる値ではない（engine の
// examples/fonts.ts が実測したもの）。
//
//     em 10ドット、全角 12ドット幅、半角 6ドット幅、字の絵は 11x9
//     字の下端はベースラインの 42/1024 em 下。10ドットの em は
//     ベースラインのすぐ上に、10行そのまま載る
//
// 作品は size 10・stretch 1 で使う（@fanm/work の DOT_STYLE）。それ以外の
// 大きさも整数倍で組めるが、ブラウザ側は拡大したビットマップになるので、
// 見た目は揃わない。

import { gunzipSync } from "node:zlib";
import type { Coverage, ResolvedStyle } from "fantasy-msx";
import { DOT_BITS, DOT_CHARS_FULL, DOT_CHARS_HALF, DOT_COLS, DOT_ROWS } from "./dot-font.js";

/** この面が字を描いている大きさ。1ドットが1画素になる size。 */
export const DOT_SIZE = 10;

/** フォントの縦の寸法（units / 1024em）。box の高さはブラウザと同じ式で出す。 */
const ASCENT = 880;
const DESCENT = 144;
const UPEM = 1024;

interface Glyph {
    readonly cols: number;
    /** 上の行から DOT_ROWS 行。各行、左のドットが最上位ビット。 */
    readonly rows: Uint16Array;
}

let table: Map<string, Glyph> | null = null;

/** 収録した文字を、引ける形に開く。最初に組むときだけ走る。 */
function glyphs(): Map<string, Glyph> {
    if (table) return table;
    const bytes = gunzipSync(Buffer.from(DOT_BITS, "base64"));
    const map = new Map<string, Glyph>();
    let at = 0;
    // 半角が先、全角が後。どちらに載っているかが、その字の幅。
    for (const char of DOT_CHARS_HALF + DOT_CHARS_FULL) {
        const cols = map.size < DOT_CHARS_HALF.length ? DOT_COLS.half : DOT_COLS.full;
        const size = cols === DOT_COLS.half ? 8 : 15;
        // 1字分のビットを、下の行の右端から詰めてある。上の行から読み直す。
        let bits = 0n;
        for (let i = 0; i < size; ++i) bits = (bits << 8n) | BigInt(bytes[at + i]);
        const rows = new Uint16Array(DOT_ROWS);
        const mask = (1n << BigInt(cols)) - 1n;
        for (let row = DOT_ROWS - 1; row >= 0; --row) {
            rows[row] = Number(bits & mask);
            bits >>= BigInt(cols);
        }
        map.set(char, { cols, rows });
        at += size;
    }
    table = map;
    return map;
}

/** 収録していない字。豆腐を出す。黙って空けると、抜けに気づけない。 */
function tofu(cols: number): Glyph {
    const rows = new Uint16Array(DOT_ROWS);
    const full = (1 << cols) - 1;
    const sides = 1 | (1 << (cols - 1));
    for (let row = 1; row <= 9; ++row) rows[row] = row === 1 || row === 9 ? full : sides;
    return { cols, rows };
}

/** 収録していない字の幅は、東アジアの字幅で決める。カナも漢字も全角。 */
function missingCols(char: string): number {
    const code = char.codePointAt(0)!;
    return code < 0x1100 || (code >= 0xff61 && code <= 0xffdf) ? DOT_COLS.half : DOT_COLS.full;
}

function glyph(char: string): Glyph {
    return glyphs().get(char) ?? tofu(missingCols(char));
}

/**
 * 文字列を、1画素ずつの覆い（0 か 255）にする。
 *
 * ブラウザのラスタライザと同じ約束で返す。box の左上が原点、baseline は
 * その上端から数えた行数、alpha は覆い。ドット面なので中間の値はない。
 */
export function rasteriseWithDots(text: string, style: ResolvedStyle): Coverage {
    const scale = Math.max(1, Math.round(style.size / DOT_SIZE));
    const lines = text.split("\n");

    const advance = (char: string) => glyph(char).cols * scale * style.stretch + style.letterSpacing;
    const widths = lines.map(line => [...line].reduce((sum, char) => sum + advance(char), 0));

    const ascent = (ASCENT / UPEM) * DOT_SIZE * scale;
    const descent = (DESCENT / UPEM) * DOT_SIZE * scale;
    const baseline = Math.ceil(ascent);
    const lineHeight = Math.max(1, Math.round(style.lineHeight ?? ascent + descent));
    const width = Math.max(1, Math.ceil(Math.max(...widths)));
    const height = Math.max(1, baseline + Math.ceil(descent) + (lines.length - 1) * lineHeight);
    const alpha = new Uint8Array(width * height);

    for (let n = 0; n < lines.length; ++n) {
        const slack = width - widths[n];
        const indent = style.align === "center" ? slack / 2 : style.align === "right" ? slack : 0;
        let pen = indent;
        for (const char of [...lines[n]]) {
            const { cols, rows } = glyph(char);
            const left = Math.round(pen);
            // em の 10 行は、ベースラインのすぐ上に 10 行そのまま載る。
            const top = baseline - DOT_ROWS * scale + n * lineHeight;
            for (let row = 0; row < DOT_ROWS; ++row) {
                const bits = rows[row];
                if (!bits) continue;
                for (let col = 0; col < cols; ++col) {
                    if (!(bits & (1 << (cols - 1 - col)))) continue;
                    const x0 = left + Math.round(col * scale * style.stretch);
                    const x1 = left + Math.round((col + 1) * scale * style.stretch);
                    for (let y = top + row * scale; y < top + (row + 1) * scale; ++y) {
                        if (y < 0 || y >= height) continue;
                        for (let x = x0; x < x1; ++x) {
                            if (x >= 0 && x < width) alpha[y * width + x] = 255;
                        }
                    }
                }
            }
            pen += advance(char);
        }
    }
    return { width, height, alpha, baseline, lineHeight };
}
