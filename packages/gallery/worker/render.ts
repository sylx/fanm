import type { CatalogEntry } from "../src/catalog-entry.js";
import { workURL } from "../src/catalog-entry.js";

export const SITE_TITLE = "fanM - AIが無限にMSX2風のデモを作り続けるサイト";
export const SITE_DESCRIPTION = "AIがつくり続けるMSX2風のデモ。新しい作品をブラウザで楽しめます。";
export const ORIGIN = "https://fanm.oyabanare.com";

export function escapeHTML(value: string): string {
    return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/** Vite の開発時と Worker の本番で共用。作品数に関係なく一作品だけを埋め込む。 */
export function renderWork(html: string, entry: CatalogEntry | null): string {
    const title = entry ? `${entry.title} | fanM` : "作品が見つかりません | fanM";
    const description = entry?.description ?? "指定された作品は見つかりませんでした。";
    // 既存のサイト共通メタ情報を外し、作品の情報と二重にならないようにする。
    html = html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeHTML(title)}</title>`)
        .replace(/<meta\b[^>]*(?:name="(?:description|twitter:[^"]+)"|property="og:[^"]+")[^>]*>/gi, "")
        .replace(/<link\b[^>]*rel="canonical"[^>]*>/gi, "");
    const canonical = entry ? ORIGIN + workURL(entry.id) : ORIGIN + "/";
    const image = entry ? new URL(entry.thumb, ORIGIN + "/").href : "";
    const meta = [
        `<meta name="description" content="${escapeHTML(description)}">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:site_name" content="fanM">`,
        `<meta property="og:title" content="${escapeHTML(title)}">`,
        `<meta property="og:description" content="${escapeHTML(description)}">`,
        `<meta property="og:url" content="${escapeHTML(canonical)}">`,
        // 既存のサムネイルはMSXの272x228。大画像カード用サイズとは異なる。
        `<meta name="twitter:card" content="summary">`,
        `<meta name="twitter:title" content="${escapeHTML(title)}">`,
        `<meta name="twitter:description" content="${escapeHTML(description)}">`,
        ...(entry ? [
            `<link rel="canonical" href="${escapeHTML(canonical)}">`,
            `<meta property="og:image" content="${escapeHTML(image)}">`,
            `<meta property="og:image:alt" content="${escapeHTML(entry.title)}">`,
            `<meta name="twitter:image" content="${escapeHTML(image)}">`
        ] : ['<meta name="robots" content="noindex">'])
    ].join("\n");
    const author = entry?.penName ? `作者：${escapeHTML(entry.penName)}` : "";
    const model = entry?.model ? `モデル：${escapeHTML(entry.model)}` : "";
    const summary = `<section id="work-info"><h2 id="work-title">${escapeHTML(entry?.title ?? "作品が見つかりません")}</h2><p id="work-description">${escapeHTML(description)}</p><div class="work-meta"><p id="work-date">${escapeHTML(entry?.createdAt ?? "")}</p><p id="work-author"${author ? "" : " hidden"}>${author}</p><p id="work-model"${model ? "" : " hidden"}>${model}</p></div></section>`;
    // script の終端や HTML として解釈される文字を JSON 内に残さない。
    const bootstrap = JSON.stringify(entry).replace(/</g, "\\u003c");
    return html.replace("</head>", () => `${meta}\n</head>`)
        .replace(/<section id="work-info"[^>]*>[\s\S]*?<\/section>/, () => summary)
        .replace('<script id="work-data" type="application/json">null</script>', () => `<script id="work-data" type="application/json">${bootstrap}</script>`);
}
