// 開発サーバー専用。手元のテンプレートと作品庫を、ビルドせずに再生する。
// 本番のビルドでは player.ts の import.meta.env.DEV ごと消える。

import type { WorkFactory } from "@fanm/work";

// 部門の実例（departments/<部門>/）も、部門の名前で同じように開ける。

const local = import.meta.glob<{ default: WorkFactory }>([
    "../../../templates/*/work.ts",
    "../../../departments/*/work.ts",
    "../../../var/works/*/public/work.ts"
]);

/** 同梱の画像。中身は読まず、開発サーバーの URL だけを持つ。 */
const pictures = import.meta.glob<string>([
    "../../../templates/*/images/*.png",
    "../../../departments/*/images/*.png",
    "../../../var/works/*/public/images/*.png"
], { query: "?url", import: "default", eager: true });

const places = (id: string) => [`../../../templates/${id}/`, `../../../departments/${id}/`, `../../../var/works/${id}/public/`];

export async function load(id: string): Promise<WorkFactory | null> {
    const found = places(id).map(dir => local[`${dir}work.ts`]).find(Boolean);
    return found ? (await found()).default : null;
}

/** 作品の隣の images/ にある画像。名前 → URL。 */
export function images(id: string): Record<string, string> {
    const dir = places(id).find(dir => local[`${dir}work.ts`]);
    if (!dir) return {};
    return Object.fromEntries(Object.entries(pictures)
        .filter(([path]) => path.startsWith(`${dir}images/`))
        .map(([path, src]) => [path.slice(`${dir}images/`.length, -".png".length), src]));
}
