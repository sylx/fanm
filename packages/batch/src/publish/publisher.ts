// 公開先への接続。公開先には静的ファイルだけを置く。
// 失敗しても成果物は保持し、生成し直さず公開だけ再試行する。
// 直前の正常なサイトを壊さないよう、全体を揃えてから切り替える。

export interface Publisher {
    readonly name: string;
    /** gallery の build 出力と作品群をまとめたディレクトリを公開する。 */
    publish(dir: string): Promise<void>;
}
