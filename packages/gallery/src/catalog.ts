// 目録。works/index.json を読み、サムネイルを新しい順に並べる。
//
// 作品そのものはここでは読み込まない。選ばれたときに iframe の中で
// 動的に読む。切り替えるたびに iframe ごと作り直して実行環境を捨てる。

import type { CatalogEntry } from "./catalog-entry.js";

const list = document.querySelector("#catalog") as HTMLUListElement;
const random = document.querySelector("#random") as HTMLAnchorElement;
const stage = document.querySelector("#stage") as HTMLElement;
const empty = document.querySelector("#empty") as HTMLElement;
const close = document.querySelector("#close") as HTMLAnchorElement;

let frame: HTMLIFrameElement | null = null;
let playing: CatalogEntry | null = null;

function play(entry: CatalogEntry): void {
    const next = document.createElement("iframe");
    next.title = entry.title;
    next.allow = "autoplay";
    next.src = `play.html?work=${encodeURIComponent(entry.id)}`;
    frame?.remove();
    frame = next;
    playing = entry;
    stage.hidden = false;
    stage.querySelector("#now")!.textContent = entry.controls
        ? `${entry.title} — ${entry.controls}`
        : entry.title;
    stage.append(next);
    location.hash = entry.id;
}

/** 再生をやめて一覧だけに戻す。iframe を捨てるので音も止まる。 */
function stop(): void {
    frame?.remove();
    frame = null;
    playing = null;
    stage.hidden = true;
}

// createdAt は ISO 8601。閲覧者の暦で日付だけ出す（時刻までは要らない）。
function date(iso: string): string {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? "" : at.toLocaleDateString();
}

function card(entry: CatalogEntry): HTMLLIElement {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "card";
    const image = document.createElement("img");
    image.src = entry.thumb;
    image.alt = "";
    image.loading = "lazy";
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const description = document.createElement("span");
    description.textContent = entry.description;
    const created = document.createElement("time");
    created.dateTime = entry.createdAt;
    created.textContent = date(entry.createdAt);
    button.append(image, title, description, created);
    button.addEventListener("click", () => play(entry));
    item.append(button);
    return item;
}

async function load(): Promise<CatalogEntry[]> {
    // 開発サーバーでは、公開物を組み立てる前でも手元の作品庫をそのまま見せる。
    if (import.meta.env.DEV) return (await import("./dev-catalog.js")).load();
    const response = await fetch("works/index.json");
    if (!response.ok) return [];
    return (await response.json()) as CatalogEntry[];
}

const works = await load();
if (!works.length) {
    empty.hidden = false;
} else {
    for (const work of works) list.append(card(work));
    random.hidden = false;
    random.addEventListener("click", event => {
        event.preventDefault();
        play(works[Math.floor(Math.random() * works.length)]);
    });

    close.addEventListener("click", event => {
        event.preventDefault();
        stop();
        // 履歴には積まない。戻るボタンで再生し直しになると鬱陶しいので。
        history.replaceState(null, "", location.pathname + location.search);
    });

    // 作品を選ぶとハッシュが変わり履歴が積まれる。戻る/進むでもそのとおりに
    // 動くようにする。play() 自身がハッシュを書くので、同じ作品なら何もしない。
    window.addEventListener("hashchange", () => {
        const id = location.hash.slice(1);
        if (!id) return stop();
        const wanted = works.find(w => w.id === id);
        if (wanted && wanted.id !== playing?.id) play(wanted);
    });

    const wanted = works.find(w => w.id === location.hash.slice(1));
    if (wanted) play(wanted);
}
