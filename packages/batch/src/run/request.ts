// 「いま作れ」と、動いている常駐に横から頼む。<VAR>/now に置く小さなファイル。
//
// 覚え書き（run.json）ではなく別のファイルにするのには理由がある。常駐は覚え書きを
// メモリに持ったまま30秒ごとに書き戻すので、外から run.json を直しても上書きで消える。
// 常駐が読むだけのファイルなら、動いている最中でも横から渡せる。
//
// 頼みは溜まらない。何度置いても一回分で、受け取った時点で消える。

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Request {
    readonly at: string;
    /** 頼む相手の指定（事業者の名前かモデル名）。無ければ、ふだんどおり札束から引く。 */
    readonly provider?: string;
}

export function requestPath(varDir: string): string {
    return join(varDir, "now");
}

/** 頼む。すでに頼んであれば書き直すだけ。 */
export function askNow(varDir: string, wish: Omit<Request, "at"> = {}): void {
    const request: Request = { at: new Date().toISOString(), ...wish };
    writeFileSync(requestPath(varDir), JSON.stringify(request));
}

/** 頼まれているか。消さずに見るだけ（status から）。 */
export function asked(varDir: string): Request | null {
    const path = requestPath(varDir);
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8").trim();
    // 時刻だけを書いていたころの頼みも読む（入れ替えの最中に置かれていた分）。
    try {
        return JSON.parse(text) as Request;
    } catch {
        return { at: text };
    }
}

/** 受け取る。頼まれていれば消して、その中身を返す。応じられなくても、受け取ったら消す。 */
export function takeRequest(varDir: string): Request | null {
    const request = asked(varDir);
    if (request) rmSync(requestPath(varDir), { force: true });
    return request;
}
