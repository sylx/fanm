// 目録。works/index.json を読み、サムネイルを新しい順に並べる。
//
// 作品そのものはここでは読み込まない。選ばれたときに iframe の中で
// 動的に読む。切り替えるたびに iframe ごと作り直して実行環境を捨てる。

import type { CatalogEntry } from "./catalog-entry.js";

const list = document.querySelector("#catalog") as HTMLUListElement;
const random = document.querySelector("#random") as HTMLAnchorElement;
const stage = document.querySelector("#stage") as HTMLElement;
const empty = document.querySelector("#empty") as HTMLElement;

let frame: HTMLIFrameElement | null = null;

function play(entry: CatalogEntry): void {
    const next = document.createElement("iframe");
    next.title = entry.title;
    next.allow = "autoplay";
    next.src = `play.html?work=${encodeURIComponent(entry.id)}`;
    frame?.remove();
    frame = next;
    stage.hidden = false;
    stage.querySelector("#now")!.textContent = entry.controls
        ? `${entry.title} — ${entry.controls}`
        : entry.title;
    stage.append(next);
    location.hash = entry.id;
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
    button.append(image, title, description);
    button.addEventListener("click", () => play(entry));
    item.append(button);
    return item;
}

async function load(): Promise<CatalogEntry[]> {
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
    const wanted = works.find(w => w.id === location.hash.slice(1));
    if (wanted) play(wanted);
}
