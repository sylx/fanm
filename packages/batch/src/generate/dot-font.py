#!/usr/bin/env python3
# JF Dot K12x10（engine/fantasy-msx/public/fonts）から、ドットの表を取り出す。
#
# ブラウザでは ctx.text がこの woff2 をそのまま組む。ヘッドレスの検査には
# 組む相手がいないので、同じ面のドットを先に取り出しておき、検査側の
# ラスタライザ（check/typeset.ts）がそれを並べる。だから検査で見える字と
# ギャラリーで見える字が同じになる。
#
#     pip install --target <どこか> fonttools brotli
#     PYTHONPATH=<どこか> python3 packages/batch/src/generate/dot-font.py
#
# 出力は packages/batch/src/check/dot-font.ts。エンジンのフォントを
# 差し替えたときだけ作り直す。
#
# この面は 12x10 のドットで描かれている。1ドットは 102.4 units、字の下端は
# ベースラインの 42 units 下。全角は 12 ドット幅、半角は 6 ドット幅。
# examples/fonts.ts が実測したとおりの値で、ここもそれに従う。

import base64
import gzip
import json
from pathlib import Path

from fontTools.pens.pointInsidePen import PointInsidePen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[4]
FONT = ROOT / "engine/fantasy-msx/public/fonts/JF-Dot-k12x10.woff2"
OUT = ROOT / "packages/batch/src/check/dot-font.ts"

PITCH = 102.4       # 1ドットの大きさ（units）
BOTTOM = -42.0      # 一番下のドットの下端
ROWS = 10           # セルの縦のドット数（em はこの 10 ドット）


def main() -> None:
    font = TTFont(FONT)
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    hmtx = font["hmtx"]

    half: list[str] = []
    full: list[str] = []
    bits_of: dict[str, int] = {}
    for code in sorted(cmap):
        if code > 0xFFFF or code < 0x20:
            continue
        name = cmap[code]
        cols = round(hmtx[name][0] / PITCH)
        if cols not in (6, 12):
            continue
        bits = 0
        for row in range(ROWS - 1, -1, -1):             # 上の行から
            y = BOTTOM + (row + 0.5) * PITCH
            for col in range(cols):
                pen = PointInsidePen(glyphs, ((col + 0.5) * PITCH, y))
                glyphs[name].draw(pen)
                bits = (bits << 1) | (1 if pen.getResult() else 0)
        (half if cols == 6 else full).append(chr(code))
        bits_of[chr(code)] = bits

    # 半角を先に、全角を後に。読む側は文字の幅を、どちらに載っているかで知る。
    blob = bytearray()
    for char in half:
        blob += bits_of[char].to_bytes(8, "big")            # 6ビット×10行
    for char in full:
        blob += bits_of[char].to_bytes(15, "big")           # 12ビット×10行
    packed = base64.b64encode(gzip.compress(bytes(blob), 9, mtime=0)).decode("ascii")

    def wrap(pieces: list[str], indent: str) -> str:
        return ("\n" + indent + "+ ").join(pieces)

    def chunks(chars: list[str]) -> list[str]:
        return [json.dumps("".join(chars[i:i + 32]), ensure_ascii=False) for i in range(0, len(chars), 32)]
    bit_lines = [json.dumps(packed[i:i + 116]) for i in range(0, len(packed), 116)]

    OUT.write_text(
        "// 生成物。手で直さない。packages/batch/src/generate/dot-font.py で作り直す。\n"
        "//\n"
        "// engine/fantasy-msx/public/fonts/JF-Dot-k12x10.woff2 のドットを取り出したもの。\n"
        "// 字の形はそのフォントのもので、ここにあるのは検査で同じ字を出すための写し。\n"
        "//\n"
        "// 収録した文字が、半角・全角の順に並ぶ。DOT_BITS はその順に、1字 10 行分の\n"
        "// ドットを上の行から詰めたもの（半角は 6 ビット×10 で 8 バイト、全角は\n"
        "// 12 ビット×10 で 15 バイト）を gzip して base64 にしたもの。\n"
        "\n"
        f"/** セルの縦のドット数。em はこの {ROWS} ドット。 */\n"
        f"export const DOT_ROWS = {ROWS};\n"
        "\n/** 半角・全角の横のドット数。 */\n"
        "export const DOT_COLS = { half: 6, full: 12 } as const;\n"
        "\n/** 収録した半角の文字。DOT_BITS の先頭から、この順に入っている。 */\nexport const DOT_CHARS_HALF =\n    "
        + wrap(chunks(half), "    ")
        + ";\n\n/** 収録した全角の文字。半角の続きに、この順に入っている。 */\nexport const DOT_CHARS_FULL =\n    "
        + wrap(chunks(full), "    ")
        + ";\n\n/** 各文字のドット（gzip して base64 にしたもの）。 */\nexport const DOT_BITS =\n    "
        + wrap(bit_lines, "    ")
        + ";\n",
        encoding="utf8"
    )
    print(f"半角 {len(half)} 字 + 全角 {len(full)} 字"
          f"（生 {len(blob) / 1024:.0f}KB → 圧縮 base64 {len(packed) / 1024:.0f}KB）→ {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
