// 型検査。work.ts だけを対象にした tsconfig を置いて tsc を走らせる。
// エンジンのソースも一緒に検査されるが、報告するのは work.ts の誤りだけ。

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const ROOT = resolve(import.meta.dirname, "../../../..");
const TSC = join(ROOT, "node_modules/typescript/bin/tsc");

export async function typecheck(workPath: string): Promise<string[]> {
    const dir = dirname(resolve(workPath));
    const config = join(dir, "tsconfig.json");
    writeFileSync(config, JSON.stringify({
        extends: relative(dir, join(ROOT, "tsconfig.base.json")),
        compilerOptions: { types: [], baseUrl: relative(dir, ROOT) || "." },
        files: [basename(workPath)]
    }, null, 2));
    try {
        await promisify(execFile)(process.execPath, [TSC, "-p", config, "--pretty", "false"], { cwd: dir });
        return [];
    } catch (e) {
        const out = String((e as { stdout?: string }).stdout ?? e);
        const errors = out.split("\n").filter(line => line.startsWith(basename(workPath)));
        return errors.length ? errors : [out.trim().slice(0, 2000)];
    }
}
