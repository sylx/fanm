// 制作のログ。画面と <VAR>/run.log の両方へ出す。
//
// 走っているときに別の端末から `fanm make` すると、鍵が取れないかわりに
// このファイルを追いかけて、いま何をしているか（AIの思考も）が見える。
//
// AIの思考や出力の垂れ流し（stream）は、画面が端末のときだけ画面にも出す。
// コンテナのログ（端末ではない）には一行ずつの出来事（line）だけが残り、
// 何が作られ、何が落ち、次がいつかを追える。垂れ流しは run.log にはいつも残る。

import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRunning } from "./lock.js";

/** これを超えたら run.log.1 へ送る。常駐させると思考がそのまま積もるため。 */
const MAX_BYTES = 8 * 1024 * 1024;
/** 大きさを見るのは、これだけ書き足してから。毎回 stat しない。 */
const CHECK_EVERY = 1024 * 1024;

export class Log {
    private sinceCheck = 0;
    /** 垂れ流しを画面にも出すか。 */
    private readonly echo = process.stdout.isTTY === true;
    /** 垂れ流しが行の途中で終わっているか。次の一行を行頭から始めるため。 */
    private open = { console: false, file: false };

    constructor(private readonly path: string) {
        mkdirSync(dirname(path), { recursive: true });
    }

    /** 一行。時刻をつけて画面とファイルへ。 */
    line(message: string): void {
        const text = `[${new Date().toISOString()}] ${message}\n`;
        this.toConsole(this.open.console ? `\n${text}` : text);
        this.toFile(this.open.file ? `\n${text}` : text);
    }

    /** 改行のない書き足し。AIの思考や出力をそのまま流すのに使う。 */
    stream(text: string): void {
        if (!text) return;
        if (this.echo) this.toConsole(text);
        this.toFile(text);
    }

    private toConsole(text: string): void {
        process.stdout.write(text);
        this.open.console = !text.endsWith("\n");
    }

    private toFile(text: string): void {
        appendFileSync(this.path, text);
        this.open.file = !text.endsWith("\n");
        this.sinceCheck += Buffer.byteLength(text);
        if (this.sinceCheck < CHECK_EVERY) return;
        this.sinceCheck = 0;
        // 一つ前だけ残す。古い思考を無限に持っていても仕方がない。
        if (existsSync(this.path) && statSync(this.path).size > MAX_BYTES) renameSync(this.path, `${this.path}.1`);
    }
}

/** ログに出す時刻。分まで、UTC（行頭の時刻と同じ）。 */
export function clock(at: Date): string {
    return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function logPath(varDir: string): string {
    return join(varDir, "run.log");
}

export interface FollowOptions {
    /** どれだけさかのぼって見せるか。 */
    readonly tailBytes?: number;
    /** これが true を返したら、相手が生きていても見るのをやめる。 */
    readonly until?: () => boolean;
}

/**
 * 動いているプロセスのログを追いかけて画面に流す。相手が終わるまで戻らない。
 * 今の続きからではなく、少し前から見せて、何をしているところか分かるようにする。
 *
 * 常駐は終わらないので、頼んだ制作だけを見届けたいときは until を渡す
 * （「いま作れ」の様子を見る makenow がそうしている）。
 */
export async function follow(varDir: string, options: FollowOptions = {}): Promise<void> {
    const { tailBytes = 4000, until } = options;
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
        if (until?.()) return;
        await new Promise(done => setTimeout(done, 300));
    }
}
