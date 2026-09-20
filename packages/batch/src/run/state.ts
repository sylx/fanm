// 常駐の覚え書き。<VAR>/run.json に置く。
//
// 再起動やコンテナの作り直しをまたいで、いつ作ったか・どこまで公開したか・
// 何を知らせたかを覚えておくためのもの。作品やジョブの状態はここには入れない
// （それぞれ <VAR>/works/、<VAR>/jobs/ にある）。
//
// 生死の目印（beat）も同じファイルに書く。30秒ごとに書き換わるので、
// 外から見て「止まっていないか」「いま何をしているか」が分かる。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Attention {
    readonly key: string;
    readonly message: string;
    readonly at: string;
}

export interface RunState {
    /** 最後に制作を始めた時刻。次にいつ作るかを決めるのに使う。 */
    lastAttemptAt?: string;
    lastPublishAt?: string;
    /** 送り終えた作品のid。増えた分があるときだけ公開する。 */
    published: string[];
    /** 人の対応が必要な問題。直ったら消す。 */
    attention?: Attention;
    /** 知らせた問題 → 最後に知らせた時刻。同じことを何度も鳴らさないため。 */
    notified: Record<string, string>;
    /** 生きている目印。 */
    beat?: { at: string; phase: string; next?: string };
}

const EMPTY: RunState = { published: [], notified: {} };

export function statePath(varDir: string): string {
    return join(varDir, "run.json");
}

export class StateStore {
    readonly state: RunState;

    constructor(private readonly path: string) {
        mkdirSync(dirname(path), { recursive: true });
        this.state = existsSync(path)
            ? { ...EMPTY, ...JSON.parse(readFileSync(path, "utf8")) as RunState }
            : { ...EMPTY };
    }

    /** 書くたびに一時ファイルから置き換える。途中で落ちても壊れた覚え書きは残らない。 */
    save(): void {
        writeFileSync(`${this.path}.tmp`, JSON.stringify(this.state, null, 2));
        renameSync(`${this.path}.tmp`, this.path);
    }

    change(edit: (state: RunState) => void): void {
        edit(this.state);
        this.save();
    }

    /** 生きている目印。次の予定は、渡されなければ前に分かっていたものを残す。 */
    beat(phase: string, next?: Date): void {
        this.change(s => {
            s.beat = { at: new Date().toISOString(), phase, next: next?.toISOString() ?? s.beat?.next };
        });
    }
}

/** 覚え書きを読むだけ（status から）。無ければ空。 */
export function readState(varDir: string): RunState {
    const path = statePath(varDir);
    return existsSync(path) ? { ...EMPTY, ...JSON.parse(readFileSync(path, "utf8")) as RunState } : { ...EMPTY };
}
