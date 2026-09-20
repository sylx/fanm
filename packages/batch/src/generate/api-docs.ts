// prompts/api.md を engine/fantasy-msx から作り直す。エンジンを更新したら実行する。
//
//     npm run prompts:api
//
// AIに渡すのは、README のうち作品づくりに要る節と、公開APIの型宣言。
// 型宣言はエンジンのソースから tsc で出すので、固定した版と食い違わない。
// 画像・フォント・日本語入力など、作品で使わせない機能は含めない。

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENGINE = "engine/fantasy-msx";

const SECTIONS = [
    "## How it works",
    "### Drawing takes time, and you can see it",
    "## Using the BIOS",
    "## Writing a game",
    "## Sound",
    "### Music",
    "## Machine profile"
];

/**
 * 型の名前だけ載っていても、取り得る値が分からないと当てずっぽうになる。
 * 実際に setMode("screen7") と書いて落ちたので、別名の定義も渡す。
 */
const ALIASES = ["api/v9938.d.ts", "bios/screen.d.ts", "runtime/runtime.d.ts"];

const DECLARATIONS = [
    "runtime/runtime.d.ts",
    "bios/gfx.d.ts",
    "bios/raster.d.ts",
    "bios/screen.d.ts",
    "bios/sprites.d.ts",
    "bios/sound.d.ts",
    "bios/mml.d.ts",
    "runtime/input.d.ts",
    "api/psg.d.ts",
    "api/opll.d.ts"
];

/** 見出しから、同じか上の階層の次の見出しまで。 */
function section(readme: string, heading: string): string {
    const lines = readme.split("\n");
    const start = lines.indexOf(heading);
    if (start < 0) throw new Error(`README に ${heading} がない`);
    const depth = heading.indexOf(" ");
    let end = start + 1;
    for (; end < lines.length; ++end) {
        const match = /^(#+) /.exec(lines[end]);
        if (match && match[1].length <= depth) break;
        if (match && SECTIONS.includes(lines[end])) break;
    }
    return lines.slice(start, end).join("\n").trim();
}

/** 型の別名（"G4" | "G5" ... のような、取り得る値そのもの）だけを抜き出す。 */
function aliases(dir: string): string {
    const found = new Map<string, string>();
    for (const file of ALIASES) {
        for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
            const match = /^export (?:declare )?type (\w+) = (.+);$/.exec(line.trim());
            if (match && !found.has(match[1])) found.set(match[1], line.trim());
        }
    }
    return [...found.values()].join("\n");
}

function declarations(): string {
    const out = mkdtempSync(join(tmpdir(), "fanm-dts-"));
    try {
        execFileSync(process.execPath, [
            "node_modules/typescript/bin/tsc", `${ENGINE}/src/index.ts`,
            "--declaration", "--emitDeclarationOnly", "--outDir", out,
            "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
            "--lib", "es2022,dom", "--skipLibCheck", "--stripInternal"
        ], { stdio: "inherit" });
        const aliasBlock = `### 型の別名\n\n\`\`\`ts\n${aliases(out)}\n\`\`\``;
        return [aliasBlock, ...DECLARATIONS.map(file => {
            const body = readFileSync(join(out, file), "utf8")
                .split("\n")
                .filter(line => line.trim() && !/^\s*private /.test(line))
                .join("\n");
            return `### ${file.replace(/\.d\.ts$/, "")}\n\n\`\`\`ts\n${body}\n\`\`\``;
        })].join("\n\n");
    } finally {
        rmSync(out, { recursive: true, force: true });
    }
}

const commit = execFileSync("git", ["-C", ENGINE, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const readme = readFileSync(`${ENGINE}/README.md`, "utf8");
const doc = [
    `# fantasy-msx API（${commit}）`,
    "",
    "このファイルは `npm run prompts:api` で生成する。手で編集しない。",
    "",
    "作品は `import { ... } from \"fantasy-msx\"` で読み込む。README の例にある `./src/index.js` は `fantasy-msx` と読み替える。",
    "",
    "## README 抜粋",
    "",
    ...SECTIONS.map(heading => section(readme, heading).replace(/^#/gm, "##")),
    "",
    "## 型宣言",
    "",
    declarations()
].join("\n\n").replace(/\n{3,}/g, "\n\n");

writeFileSync("prompts/api.md", doc + "\n");
console.log(`prompts/api.md: ${doc.length} 文字（fantasy-msx ${commit}）`);
