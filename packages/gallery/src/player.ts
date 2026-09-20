// プレイヤー。iframe の中で作品を一つだけ動かす。
//
// 公開時の作品は works/<id>/work.js。エンジンは含まれておらず、作品自身が
// 自分の作られた版の engine/<commit>.js を import する。プレイヤーも同じ版を
// 読んで動かす。だからエンジンを更新しても、過去の作品はビルドし直さずに動く。
//
// ここでエンジンを静的に import してはいけない。プレイヤーの中に二つ目の
// エンジンが入り、作品と別のエンジンで動くことになる。
//
// 開発中は、まだビルドしていない手元の作品やテンプレートも直接読める。

import { createEnv, type WorkFactory } from "@fanm/work";
import type { CatalogEntry } from "./catalog-entry.js";

type Engine = typeof import("fantasy-msx");
type Runtime = ReturnType<Engine["boot"]>;

interface Loaded {
    readonly factory: WorkFactory;
    readonly seed: number;
    readonly engine: Engine;
}

/**
 * VDP が出す一画面。中央の 256x212（または 512x212）と、その周りに VDP 自身が
 * 描く枠を合わせた大きさ。画面はこの整数倍でしか出さない。半端な倍率で拡大
 * すると、ある列だけ二重になって絵が崩れる。
 */
const FRAME = { width: 272, height: 228 } as const;

const CRT_KEY = "fanM.crt";

/**
 * 作品が日本語を出すためのドット面。作品自身は外から何も読めないので、
 * プレイヤーが先に読んで登録しておく（@fanm/work の DOT_STYLE がこの名前を
 * 指している）。読めなければ、作品は代替の等幅フォントで組まれる。
 */
const DOT_FONT = { family: "JF Dot K12x10", file: "fonts/JF-Dot-k12x10.woff2" } as const;

const url = (path: string) => new URL(path, location.href).href;

async function loadDotFont(): Promise<void> {
    try {
        const face = await new FontFace(DOT_FONT.family, `url(${url(DOT_FONT.file)})`).load();
        // この集合は仕様では set だが、DOM の型にはその面が無い。
        (document.fonts as FontFaceSet & { add(font: FontFace): void }).add(face);
    } catch {
        // 面が無くても作品は動く。字の形が変わるだけ。
    }
}

async function fromCatalog(id: string): Promise<Loaded | null> {
    const response = await fetch("works/index.json").catch(() => null);
    if (!response?.ok) return null;
    // 開発サーバーは無いパスに index.html を返すので、JSON とは限らない。
    const catalog = await response.json().catch(() => null) as CatalogEntry[] | null;
    const entry = catalog?.find(w => w.id === id);
    if (!entry) return null;
    const [work, engine] = await Promise.all([
        import(/* @vite-ignore */ url(entry.work)),
        import(/* @vite-ignore */ url(`engine/${entry.engine.slice(0, 12)}.js`)) as Promise<Engine>
    ]);
    return { factory: work.default as WorkFactory, seed: entry.seed, engine };
}

/** 開発サーバーのときだけ。本番のビルドには含まれない。 */
async function fromDisk(id: string): Promise<Loaded | null> {
    if (!import.meta.env.DEV) return null;
    const { load } = await import("./dev-works.js");
    const factory = await load(id);
    if (!factory) return null;
    return { factory, seed: 1, engine: await import("fantasy-msx") };
}

/** 入る中で一番大きい整数倍。窓が小さくても 1 は下回らない。 */
function scaleFor(width: number, height: number): number {
    return Math.max(1, Math.floor(Math.min(width / FRAME.width, height / FRAME.height)));
}

/** 実サイズと見かけの大きさを、同じ整数倍にそろえる。 */
function fit(canvas: HTMLCanvasElement): void {
    const scale = scaleFor(window.innerWidth, window.innerHeight);
    const width = FRAME.width * scale;
    const height = FRAME.height * scale;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
}

// ギャラリーの iframe の中なら、外側に目録がもう出ている。直接開かれた
// ときだけ、目録へ戻る道を出す。
if (window.top === window.self) (document.querySelector("#home") as HTMLElement).hidden = false;

const params = new URLSearchParams(location.search);
const id = params.get("work") ?? "ambient";
// 開発中は手元のものを先に見る。公開物を組み立て直さずに試せるように。
const found = import.meta.env.DEV
    ? (await fromDisk(id)) ?? (await fromCatalog(id))
    : (await fromCatalog(id)) ?? (await fromDisk(id));
if (!found) {
    // body ごと書き換えると戻る道も消えるので、canvas だけ差し替える。
    const error = document.createElement("p");
    error.id = "error";
    error.textContent = `作品 ${id} が見つかりません。`;
    document.querySelector("canvas")!.replaceWith(error);
    document.querySelector("#crt")!.remove();
    throw new Error(`作品 ${id} が見つからない`);
}

await loadDotFont();

const seed = params.has("seed") ? Number(params.get("seed")) : found.seed;
const button = document.querySelector("#crt") as HTMLButtonElement;
let canvas = document.querySelector("canvas") as HTMLCanvasElement;
// ?crt=1 / ?crt=0 が最優先。指定がなければ前回の選択を覚えている。
let crt = params.has("crt") ? params.get("crt") !== "0" : localStorage.getItem(CRT_KEY) === "on";
let runtime: Runtime | null = null;

/**
 * 作品を頭から動かす。canvas は最初に与えられた種類の context を一生持つので、
 * CRT を入れ切りするには canvas ごと作り直して起動し直すしかない。作品は
 * 起動のたびに状態を作り直せる形なので、そのまま最初から始まる。
 */
function launch(): void {
    runtime?.stop();
    fit(canvas);
    runtime = found!.engine.run(found!.factory(createEnv(seed)), { canvas, crt });
    // WebGL2 が無い環境では host が平面描画に落とすので、押しても効かない。
    button.setAttribute("aria-pressed", String(crt && !!runtime.crt));
}

/**
 * 目録（親の窓）から送られてくるキー。
 *
 * エンジンはこの窓の keydown を聞いている。焦点が目録の側にあるときは、
 * そちらにしか届かない。だから目録が遊びのキーだけを転送してくる。
 * 焦点がこちらにあるときは、目録には何も届かないので重ならない。
 */
window.addEventListener("message", event => {
    if (event.origin !== location.origin) return;
    const data = event.data as { fanm?: unknown; code?: unknown; down?: unknown };
    if (data?.fanm !== "key" || typeof data.code !== "string") return;
    runtime?.input.setKey(data.code, data.down === true);
});

// 画面を触られたら、以後のキーはこちらで受ける。
window.addEventListener("pointerdown", () => window.focus());

button.addEventListener("click", () => {
    crt = !crt;
    localStorage.setItem(CRT_KEY, crt ? "on" : "off");
    const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
    canvas.replaceWith(fresh);
    canvas = fresh;
    launch();
});

// 窓の大きさが変わったら倍率を取り直す。実サイズが変わらなければ何も起きない。
let pending = 0;
window.addEventListener("resize", () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => fit(canvas));
});

launch();
