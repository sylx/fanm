// 目録。works/index.json を読み、新着順に並べる。作品は iframe の中で
// 再生し、切り替えるたびに iframe ごと作り直して実行環境を捨てる。
//
// TODO: 作品ごとのURL（#<id>）、サムネイル、連続再生。

import type { WorkMeta } from "@fanm/work";

const catalog = document.querySelector("#catalog") as HTMLUListElement;
const random = document.querySelector("#random") as HTMLAnchorElement;
let frame = document.querySelector("#player") as HTMLIFrameElement;

function play(id: string): void {
    const next = frame.cloneNode() as HTMLIFrameElement;
    next.hidden = false;
    next.src = `play.html?work=${encodeURIComponent(id)}`;
    frame.replaceWith(next);
    frame = next;
}

async function load(): Promise<WorkMeta[]> {
    const response = await fetch("works/index.json");
    if (!response.ok) return [];
    const works = (await response.json()) as WorkMeta[];
    return works.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const works = await load();
for (const work of works) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.textContent = work.title;
    button.addEventListener("click", () => play(work.id));
    item.append(button, ` ${work.description}`);
    catalog.append(item);
}
random.addEventListener("click", event => {
    event.preventDefault();
    if (works.length) play(works[Math.floor(Math.random() * works.length)].id);
});
