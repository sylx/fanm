// 制作のログ。画面と <VAR>/run.log の両方へ出す。
//
// 走っているときに別の端末から `fanm make` すると、鍵が取れないかわりに
// このファイルを追いかけて、いま何をしているか（AIの思考も）が見える。

import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRunning } from "./lock.js";

/** これを超えたら run.log.1 へ送る。常駐させると思考がそのまま積もるため。 */
const MAX_BYTES = 8 * 1024 * 1024;
/** 大きさを見るのは、これだけ書き足してから。毎回 stat しない。 */
const CHECK_EVERY = 1024 * 1024;

export class Log {
    private sinceCheck = 0;

    constructor(private readonly path: string) {
        mkdirSync(dirname(path), { recursive: true });
    }

    /** 一行。時刻をつけて画面とファイルへ。 */
    line(message: string): void {
        this.write(`[${new Date().toISOString()}] ${message}\n`);
    }

    /** 改行のない書き足し。AIの思考や出力をそのまま流すのに使う。 */
    stream(text: string): void {
        this.write(text);
    }

    private write(text: string): void {
        process.stdout.write(text);
        appendFileSync(this.path, text);
        this.sinceCheck += Buffer.byteLength(text);
        if (this.sinceCheck < CHECK_EVERY) return;
        this.sinceCheck = 0;
        // 一つ前だけ残す。古い思考を無限に持っていても仕方がない。
        if (existsSync(this.path) && statSync(this.path).size > MAX_BYTES) renameSync(this.path, `${this.path}.1`);
    }
}

export function logPath(varDir: string): string {
    return join(varDir, "run.log");
}

/**
 * 動いているプロセスのログを追いかけて画面に流す。相手が終わるまで戻らない。
 * 今の続きからではなく、少し前から見せて、何をしているところか分かるようにする。
 */
export async function follow(varDir: string, tailBytes = 4000): Promise<void> {
    const path = logPath(varDir);
    let offset = Math.max(0, (existsSync(path) ? statSync(path).size : 0) - tailBytes);
    const buffer = Buffer.alloc(64 * 1024);

    for (;;) {
        if (existsSync(path)) {
            const size = statSync(path).size;
            if (size < offset) offset = 0;      // 入れ替わった（run.log.1 へ送られた）
            while (offset < size) {
                const fd = openSync(path, "r");
                const read = readSync(fd, buffer, 0, buffer.length, offset);
                closeSync(fd);
                if (read <= 0) break;
                process.stdout.write(buffer.subarray(0, read).toString("utf8"));
                offset += read;
            }
        }
        if (!isRunning(varDir)) return;
        await new Promise(done => setTimeout(done, 300));
    }
}
