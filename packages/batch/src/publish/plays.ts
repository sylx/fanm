// 作品ごとの再生回数を、Workers Analytics Engine から引いてくる。
//
// 数えているのはギャラリーの Worker（packages/gallery/worker の /api/play）。
// 一行が一回の再生で、blob1 が作品、blob2 が経路（pick / auto / direct）、blob3 が国。
// Analytics Engine は数が多いと間引いて記録するので、回数は _sample_interval を足して戻す。
// 残るのは三か月まで。
//
// 認証は wrangler と同じ CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_API_TOKEN を使う。トークンには
// 「Account Analytics: Read」の権限が要る（deploy 用の権限だけでは読めない）。

export const DATASET = "fanm_plays";

export interface PlayCount {
    readonly work: string;
    readonly pick: number;
    readonly auto: number;
    readonly direct: number;
    readonly total: number;
}

export async function fetchPlays(days: number, env: NodeJS.ProcessEnv = process.env): Promise<PlayCount[]> {
    const account = env.CLOUDFLARE_ACCOUNT_ID;
    const token = env.CLOUDFLARE_API_TOKEN;
    if (!account || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_API_TOKEN が要る");
    if (!Number.isInteger(days) || days < 1 || days > 92) throw new Error("日数は 1〜92 で指定する");
    const sql = `SELECT blob1 AS work, blob2 AS via, SUM(_sample_interval) AS plays
        FROM ${DATASET}
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY work, via
        FORMAT JSON`;
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: sql
    });
    const text = await response.text();
    if (!response.ok) {
        const hint = response.status === 401 || response.status === 403 ? "（API トークンに Account Analytics: Read の権限があるか）" : "";
        throw new Error(`Analytics Engine に問い合わせられない: ${response.status}${hint}\n${text.slice(0, 500)}`);
    }
    const rows = (JSON.parse(text) as { data: { work: string; via: string; plays: number | string }[] }).data;
    const byWork = new Map<string, { pick: number; auto: number; direct: number }>();
    for (const row of rows) {
        const counts = byWork.get(row.work) ?? { pick: 0, auto: 0, direct: 0 };
        if (row.via === "pick" || row.via === "auto" || row.via === "direct") counts[row.via] += Number(row.plays);
        byWork.set(row.work, counts);
    }
    return [...byWork].map(([work, c]) => ({ work, ...c, total: c.pick + c.auto + c.direct }))
        .sort((a, b) => b.total - a.total || a.work.localeCompare(b.work));
}
