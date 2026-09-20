// 「いま作れ」と、動いている常駐に横から頼む。<VAR>/now に置く小さなファイル。
//
// 覚え書き（run.json）ではなく別のファイルにするのには理由がある。常駐は覚え書きを
// メモリに持ったまま30秒ごとに書き戻すので、外から run.json を直しても上書きで消える。
// 常駐が読むだけのファイルなら、動いている最中でも横から渡せる。
//
// 頼みは溜まらない。何度置いても一回分で、受け取った時点で消える。

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function requestPath(varDir: string): string {
    return join(varDir, "now");
}

/** 頼む。すでに頼んであれば時刻を書き直すだけ。 */
export function askNow(varDir: string): void {
    writeFileSync(requestPath(varDir), new Date().toISOString());
}

/** 頼まれているか。消さずに見るだけ（status から）。 */
export function asked(varDir: string): string | null {
    const path = requestPath(varDir);
    return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}

/** 受け取る。頼まれていれば消して true。応じられなくても、受け取ったら消す。 */
export function takeRequest(varDir: string): boolean {
    const path = requestPath(varDir);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
}
