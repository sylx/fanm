// 制作は一度に一つだけ。<VAR>/run.lock に pid を書いて占有する。
//
// 二重に起動すると、同じジョブを二つのプロセスが進めてしまい、
// 予約だけ残った台帳や、宙に浮いた試行ができる。実際にそうなった。

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LockInfo {
    readonly pid: number;
    readonly since: string;
}

export interface Held {
    readonly held: true;
    release(): void;
}

export type LockResult = Held | { readonly held: false; readonly by: LockInfo };

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export function lockPath(varDir: string): string {
    return join(varDir, "run.lock");
}

/** 取れたら Held。ほかのプロセスが動いていればその情報を返す。 */
export function acquire(varDir: string): LockResult {
    const path = lockPath(varDir);
    if (existsSync(path)) {
        const info = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
        if (info.pid !== process.pid && alive(info.pid)) return { held: false, by: info };
        rmSync(path, { force: true });      // 前回の異常終了で残った鍵
    }
    const info: LockInfo = { pid: process.pid, since: new Date().toISOString() };
    writeFileSync(path, JSON.stringify(info));

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        rmSync(path, { force: true });
    };
    for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
            release();
            if (signal !== "exit") process.exit(130);
        });
    }
    return { held: true, release };
}

export function isRunning(varDir: string): LockInfo | null {
    const path = lockPath(varDir);
    if (!existsSync(path)) return null;
    const info = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
    return alive(info.pid) ? info : null;
}
