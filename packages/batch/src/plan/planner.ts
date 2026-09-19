// 企画。過去作品の短い要約と制作ルールから、次の企画を決める。
// 過去の全コードや会話履歴は渡さない。
//
// TODO: 実装。

export interface Plan {
    readonly title: string;
    readonly pitch: string;
    /** 偏りを避けるための軸。過去作品の要約にも同じ軸で記録する。 */
    readonly subject: string;
    readonly motion: string;
    readonly sound: string;
    readonly msxFeatures: readonly string[];
    readonly interactive: boolean;
}
