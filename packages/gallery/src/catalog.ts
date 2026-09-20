// 目録。works/index.json を読み、サムネイルを新しい順に並べる。
//
// 作品そのものはここでは読み込まない。選ばれたときに iframe の中で
// 動的に読む。切り替えるたびに iframe ごと作り直して実行環境を捨てる。
//
// キーボードは焦点のある文書にしか届かない。作品は iframe の中で動いている
// ので、目録に焦点が残っていると、操作できる作品が一切反応しない。だから
// 選んだ時点で iframe へ焦点を移し、それでも目録の側にキーが届いたときは
// （閉じるボタンを押したあとなど）、そのキーを iframe へ送る。同じ押鍵が
// 両方の文書に届くことはないので、二重には入らない。

import type { CatalogEntry } from "./catalog-entry.js";

const list = document.querySelector("#catalog") as HTMLUListElement;
const random = document.querySelector("#random") as HTMLAnchorElement;
const stage = document.querySelector("#stage") as HTMLElement;
const empty = document.querySelector("#empty") as HTMLElement;
const close = document.querySelector("#close") as HTMLAnchorElement;

let frame: HTMLIFrameElement | null = null;
let playing: CatalogEntry | null = null;

/** エンジンが遊びに使うキー（fantasy-msx の DEFAULT_KEY_MAP）。 */
const PLAY_KEYS = new Set([
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyZ", "KeyX",
    "KeyW", "KeyA", "KeyS", "KeyD", "KeyN", "KeyM"
]);

/** 目録の側で押されたまま送ったキー。焦点が外れたときに離してやる。 */
const forwarded = new Set<string>();

function send(code: string, down: boolean): void {
    frame?.contentWindow?.postMessage({ fanm: "key", code, down }, location.origin);
    if (down) forwarded.add(code);
    else forwarded.delete(code);
}

function releaseForwarded(): void {
    for (const code of [...forwarded]) send(code, false);
}

function play(entry: CatalogEntry): void {
    const next = document.createElement("iframe");
    next.title = entry.title;
    next.allow = "autoplay";
    next.src = `play.html?work=${encodeURIComponent(entry.id)}`;
    // 読み込み終わってから焦点を移す。ここで移さないと、カードを押した指の
    // 行き先は目録のボタンのままで、矢印キーは目録を送るだけになる。
    next.addEventListener("load", () => next.contentWindow?.focus());
    releaseForwarded();
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
    forwarded.clear();
    frame?.remove();
    frame = null;
    playing = null;
    stage.hidden = true;
}

// 目録に焦点が残ったままでも遊べるように、遊びのキーだけを作品へ送る。
// 矢印で目録が動いてしまわないよう、送ったキーはここで止める。
for (const [type, down] of [["keydown", true], ["keyup", false]] as const) {
    window.addEventListener(type, event => {
        const key = event as KeyboardEvent;
        if (!frame || key.repeat || key.ctrlKey || key.metaKey || key.altKey) return;
        if (!PLAY_KEYS.has(key.code)) return;
        send(key.code, down);
        key.preventDefault();
    });
}

// 窓から出たまま押されていたキーは、押しっぱなしとして残ってしまう。
window.addEventListener("blur", releaseForwarded);

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
