// 目録の一件。バッチが works/index.json に書く形（batch の publish/site.ts と同じ）。

import type { WorkMeta } from "@fanm/work";

export interface CatalogEntry extends WorkMeta {
    /** 目録から見た作品とサムネイルの場所。 */
    readonly work: string;
    readonly thumb: string;
}
