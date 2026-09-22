// 目録の一件。バッチが works/index.json に書く形（batch の publish/site.ts と同じ）。

import type { WorkMeta } from "@fanm/work";

export interface CatalogEntry extends WorkMeta {
    /** 目録から見た作品とサムネイルの場所。 */
    readonly work: string;
    readonly thumb: string;
}

/** 検索とランダム選択に使う索引。説明文や再生情報は必要な分だけ取得する。 */
export interface CatalogItem {
    readonly id: string;
    readonly title: string;
    readonly createdAt: string;
    readonly model?: string;
    readonly chunk: string;
}

export interface CatalogIndex {
    readonly revision: string;
    readonly items: readonly CatalogItem[];
}

export const PAGE_SIZE = 16;
export const workURL = (id: string): string => `/work/${encodeURIComponent(id)}/`;
