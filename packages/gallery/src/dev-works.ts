// 開発サーバー専用。手元のテンプレートと作品庫を、ビルドせずに再生する。
// 本番のビルドでは player.ts の import.meta.env.DEV ごと消える。

import type { WorkFactory } from "@fanm/work";

const local = import.meta.glob<{ default: WorkFactory }>([
    "../../../templates/*/work.ts",
    "../../../var/works/*/public/work.ts"
]);

export async function load(id: string): Promise<WorkFactory | null> {
    const found = local[`../../../templates/${id}/work.ts`] ?? local[`../../../var/works/${id}/public/work.ts`];
    return found ? (await found()).default : null;
}
