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
//
// 作品は増えていくばかりなので、一覧は最初の何枚かだけ並べ、あとは
// 「もっと見る」で継ぎ足す。名前で直に呼ばれた作品がまだ並んでいなければ、
// そこまで並べてから再生する。
//
// 音も iframe の中で鳴る。iPhone は人が触るまで音を出させず、その「触った」は
// 作品の窓には起きない（触られているのは目録のカードで、作品の窓ではない）。
// そこでカードを押したその場で、目録の側が無音を一つ鳴らして頁の錠を外し、
// 作品の窓には「起きろ」とだけ伝える。
//
// ランダム再生は入り切りのある状態。入れているあいだは一定の間隔で次の作品を
// くじで選んで流し続ける。人がカードを選んだり一覧に戻ったりしたら切れる。

import type { CatalogEntry } from "./catalog-entry.js";

const list = document.querySelector("#catalog") as HTMLUListElement;
const random = document.querySelector("#random") as HTMLButtonElement;
const stage = document.querySelector("#stage") as HTMLElement;
const empty = document.querySelector("#empty") as HTMLElement;
const close = document.querySelector("#close") as HTMLAnchorElement;
const more = document.querySelector("#more") as HTMLButtonElement;

let frame: HTMLIFrameElement | null = null;
let playing: CatalogEntry | null = null;

/** エンジンが遊びに使うキー（fantasy-msx の DEFAULT_KEY_MAP）。 */
const PLAY_KEYS = new Set([
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyZ", "KeyX",
    "KeyW", "KeyA", "KeyS", "KeyD", "KeyN", "KeyM"
]);

/**
 * 頁の音の錠を外す。人が触っているあいだに呼ぶこと。
 *
 * 一標本ぶんの無音を鳴らすだけ。何が鳴るかは問題ではなく、人の身振りの中で
 * 一度でも鳴らしたという事実が要る。外れた錠は同じ頁の iframe にも効く。
 */
let wakeup: AudioContext | null = null;
function unlock(): void {
    try {
        const sound = (wakeup ??= new AudioContext());
        void sound.resume();
        const silence = sound.createBufferSource();
        silence.buffer = sound.createBuffer(1, 1, sound.sampleRate);
        silence.connect(sound.destination);
        silence.start();
    } catch {
        // 音を出せない閲覧環境。絵だけ見てもらう。
    }
}

/**
 * 作品の音を起こす。錠が外れていても、エンジンは自分の窓が触られるまで
 * 音を止めたままなので、こちらから起こしてやる必要がある。
 */
function wake(): void {
    frame?.contentWindow?.postMessage({ fanm: "audio" }, location.origin);
}

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

/** ランダム再生で一つの作品を流す長さ。 */
const SHUFFLE_MS = 60_000;

/** ランダム再生の次の切り替え。切っているあいだは null。 */
let shuffle: number | null = null;

/**
 * 再生の仕方。auto はランダム再生が自分で次へ送ったときで、人は画面の
 * どこかを見ているかもしれない。だから頁を動かさず、履歴も積まない。
 */
interface PlayOptions { auto?: boolean }

function play(entry: CatalogEntry, { auto = false }: PlayOptions = {}): void {
    const next = document.createElement("iframe");
    next.title = entry.title;
    next.allow = "autoplay";
    next.src = `play.html?work=${encodeURIComponent(entry.id)}`;
    // 読み込み終わってから焦点を移す。ここで移さないと、カードを押した指の
    // 行き先は目録のボタンのままで、矢印キーは目録を送るだけになる。音も
    // このときに起こす。作品はもう動いていて、あとは鳴るのを待つだけ。
    // ランダム再生が勝手に送ったときは、焦点が作品にあった場合だけ移す。
    // 人が一覧を見ているさなかに焦点を奪うと、頁が作品の方へ引き戻される。
    const focus = !auto || document.activeElement === frame;
    next.addEventListener("load", () => {
        if (focus) next.contentWindow?.focus();
        wake();
    });
    // 押された指がまだ画面にあるうちに外す。後から外そうとしても遅い。
    unlock();
    releaseForwarded();
    frame?.remove();
    frame = next;
    playing = entry;
    stage.hidden = false;
    stage.querySelector("#now")!.textContent = entry.controls
        ? `${entry.title} — ${entry.controls}`
        : entry.title;
    stage.append(next);
    // ランダム再生中なら、いま流し始めた作品から数え直す。
    if (shuffle !== null) schedule();
    if (auto) {
        // hashchange は起きないが、起きても同じ作品なので何もしない。
        history.replaceState(null, "", `#${encodeURIComponent(entry.id)}`);
        return;
    }
    location.hash = entry.id;
    // 押したカードは一覧の下の方にあることが多い。舞台は画面の外なので、
    // 運んでやらないと切り替わったことが伝わらない。ハッシュを書いたあとに
    // 動かす。行き先のない名前でも、位置を決めるのは browser が先になる。
    stage.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** ランダム再生の次の切り替えを、いまから SHUFFLE_MS 後に置き直す。 */
function schedule(): void {
    if (shuffle !== null) clearTimeout(shuffle);
    shuffle = window.setTimeout(() => shuffleNext(true), SHUFFLE_MS);
}

/** くじで一つ選んで流す。いま流れている作品は、ほかがあるかぎり引かない。 */
function shuffleNext(auto: boolean): void {
    const pool = works.length > 1 ? works.filter(work => work.id !== playing?.id) : works;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (!auto) reveal(works.indexOf(pick) + 1);
    play(pick, { auto });
}

function startShuffle(): void {
    random.setAttribute("aria-pressed", "true");
    random.textContent = "ランダム再生中";
    schedule();
    shuffleNext(false);
}

function stopShuffle(): void {
    if (shuffle !== null) clearTimeout(shuffle);
    shuffle = null;
    random.setAttribute("aria-pressed", "false");
    random.textContent = "ランダム再生";
}

/** 再生をやめて一覧だけに戻す。iframe を捨てるので音も止まる。 */
function stop(): void {
    stopShuffle();
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
        if (!frame || key.ctrlKey || key.metaKey || key.altKey) return;
        if (!PLAY_KEYS.has(key.code)) return;
        // 押しっぱなしの繰り返しは作品へは送らない（作品が自分で繰り返す）が、
        // 止めるのは止める。見逃すと矢印を押し続けたとき頁が送られてしまう。
        if (!key.repeat) send(key.code, down);
        key.preventDefault();
    });
}

// 窓から出たまま押されていたキーは、押しっぱなしとして残ってしまう。
window.addEventListener("blur", releaseForwarded);

// 最初の一押しで錠が外れなかったとき（作品を開く前に押されていた場合など）の
// 取り返し。目録の側が触られるたびに外し直して、鳴っていなければ起こす。
window.addEventListener("pointerdown", () => {
    unlock();
    wake();
});

// createdAt は ISO 8601。閲覧者の暦で時刻まで表示する。UTC で保存されているので、タイムゾーンの差を吸収してくれる。
function date(iso: string): string {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? "" : at.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
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
    // 日付と、書いたAIの名前を同じ行に。モデル名を残す前の作品には無いので、
    // そのときは日付だけが出る。
    const foot = document.createElement("small");
    foot.className = "foot";
    foot.append(created);
    if (entry.model) {
        const model = document.createElement("span");
        model.className = "model";
        model.textContent = entry.model;
        foot.append(model);
    }
    button.append(image, title, description, foot);
    // 人が自分で選んだら、くじはもう要らない。
    button.addEventListener("click", () => {
        stopShuffle();
        play(entry);
    });
    item.append(button);
    return item;
}

/** 一度に並べる枚数。最初はこれだけ出して、あとは押されるたびに継ぎ足す。 */
const PAGE = 8;

/** すでに並べた枚数。works の先頭からこの数だけが一覧に出ている。 */
let shown = 0;

/** 先頭から upto 枚目までを並べる。すでに並んでいる分は作り直さない。 */
function reveal(upto: number = shown + PAGE): void {
    for (const work of works.slice(shown, Math.min(upto, works.length))) list.append(card(work));
    shown = Math.max(shown, Math.min(upto, works.length));
    const rest = works.length - shown;
    more.textContent = `もっと見る（残り ${rest} 件）`;
    more.hidden = rest <= 0;
}

/** 名前で作品へ飛ぶ。まだ並んでいなければ、そこまで並べてから再生する。 */
function jump(id: string): void {
    const at = works.findIndex(work => work.id === id);
    if (at < 0 || works[at].id === playing?.id) return;
    reveal(at + 1);
    play(works[at]);
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
    reveal();
    more.addEventListener("click", () => reveal());
    random.hidden = false;
    random.addEventListener("click", () => {
        if (shuffle !== null) stopShuffle();
        else startShuffle();
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
        jump(id);
    });

    jump(location.hash.slice(1));
}
