import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { PAGE_SIZE, workURL, type CatalogEntry, type CatalogIndex } from "./catalog-entry.js";
import { ORIGIN, SITE_DESCRIPTION, SITE_TITLE } from "../worker/render.js";

const PLAY_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyZ", "KeyX", "KeyW", "KeyA", "KeyS", "KeyD", "KeyN", "KeyM"]);
const initialWork = JSON.parse(document.querySelector("#work-data")!.textContent!) as CatalogEntry | null;
const entryCache = new Map<string, CatalogEntry>();
if (initialWork) entryCache.set(initialWork.id, initialWork);
const chunks = new Map<string, CatalogEntry[]>();

interface Route { id: string | null; search: string }
const readRoute = (): Route => ({ id: /^\/work\/([a-zA-Z0-9_-]+)\/$/.exec(location.pathname)?.[1] ?? null, search: location.search });
const date = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
async function json<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(path, { signal });
    if (!response.ok) throw new Error(response.status === 404 ? "作品または一覧が見つかりません。" : "読み込めませんでした。時間をおいて再度お試しください。");
    return response.json() as Promise<T>;
}

let sound: AudioContext | undefined;
function unlock(): void {
    try {
        sound ??= new AudioContext();
        void sound.resume();
        const silence = sound.createBufferSource();
        silence.buffer = sound.createBuffer(1, 1, sound.sampleRate);
        silence.connect(sound.destination);
        silence.start();
    } catch { /* 音を出せない環境でも絵は再生する。 */ }
}

/** 初回の紹介文は Worker が返す。React の管理領域の外にあるこの情報だけ同期する。 */
function updateDescription(work: CatalogEntry | null): void {
    document.querySelector<HTMLElement>("#work-info")!.hidden = !work;
    document.querySelector("#work-title")!.textContent = work?.title ?? "";
    document.querySelector("#work-description")!.textContent = work?.description ?? "";
    document.querySelector("#work-date")!.textContent = work ? date(work.createdAt) : "";
    const author = document.querySelector<HTMLElement>("#work-author")!;
    author.textContent = work?.penName ? `作者：${work.penName}` : "";
    author.hidden = !work?.penName;
    const model = document.querySelector<HTMLElement>("#work-model")!;
    model.textContent = work?.model ? `モデル：${work.model}` : "";
    model.hidden = !work?.model;
    document.title = work ? `${work.title} | fanM` : SITE_TITLE;
    const title = document.title;
    const description = work?.description ?? SITE_DESCRIPTION;
    for (const [selector, value] of [
        ['meta[name="description"]', description], ['meta[property="og:title"]', title],
        ['meta[property="og:description"]', description], ['meta[name="twitter:title"]', title],
        ['meta[name="twitter:description"]', description], ['meta[property="og:url"]', ORIGIN + (work ? workURL(work.id) : "/")]
    ]) document.querySelector(selector)?.setAttribute("content", value);
    let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) { canonical = document.createElement("link"); canonical.rel = "canonical"; document.head.append(canonical); }
    canonical.href = ORIGIN + (work ? workURL(work.id) : "/");
    if (work) {
        for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
            document.querySelector(selector)?.setAttribute("content", new URL(work.thumb, ORIGIN + "/").href);
        }
        for (const selector of ['meta[property="og:image:width"]', 'meta[property="og:image:height"]', 'meta[name="robots"]']) document.querySelector(selector)?.remove();
    }
}

function App() {
    const [route, setRoute] = useState(readRoute);
    const [index, setIndex] = useState<CatalogIndex | null>(null);
    const [cards, setCards] = useState<CatalogEntry[]>([]);
    const [work, setWork] = useState<CatalogEntry | null>(initialWork);
    const [error, setError] = useState("");
    const [workError, setWorkError] = useState("");
    const [loading, setLoading] = useState(true);
    const [shuffle, setShuffle] = useState(false);
    const [retry, setRetry] = useState(0);
    const frame = useRef<HTMLIFrameElement>(null);
    const stage = useRef<HTMLElement>(null);
    const gallery = useRef<HTMLElement>(null);
    const focusPlayer = useRef(true);
    const returnScroll = useRef(0);
    const restore = useRef<{ y: number; focus?: string } | null>(null);
    const params = new URLSearchParams(route.search);
    const query = params.get("q") ?? "";
    const month = params.get("month") ?? "";
    const oldest = params.get("order") === "oldest";
    const requestedPage = Math.max(1, Math.floor(Number(params.get("page")) || 1));
    const filtered = useMemo(() => {
        const result = index?.items.filter(item => (!month || item.createdAt.startsWith(month)) && (!query || `${item.title} ${item.penName ?? ""} ${item.model ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) ?? [];
        return oldest ? result.reverse() : result;
    }, [index, month, query, oldest]);
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const page = Math.min(requestedPage, pages);
    const visible = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);
    const months = useMemo(() => [...new Set(index?.items.map(item => item.createdAt.slice(0, 7)))], [index]);
    const selectedAt = index?.items.findIndex(item => item.id === route.id) ?? -1;

    function navigate(id: string | null, options: { auto?: boolean; search?: string; restore?: boolean; replace?: boolean } = {}) {
        const auto = options.auto ?? false;
        if (!auto) setShuffle(false);
        focusPlayer.current = !auto || document.activeElement === frame.current;
        const search = options.search ?? route.search;
        if (!auto) {
            history.replaceState({ ...history.state, scroll: window.scrollY }, "");
            if (id && !route.id) returnScroll.current = window.scrollY;
        }
        const url = (id ? workURL(id) : "/") + search;
        if (auto || options.replace) history.replaceState({ ...history.state }, "", url);
        else history.pushState({ returnScroll: returnScroll.current, returnId: id ?? route.id }, "", url);
        setRoute({ id, search });
        if (id !== route.id) {
            // 次のメタデータを待つ間も現在の舞台を保ち、連続再生で一覧を上下させない。
            if (!id) setWork(null);
            else if (entryCache.has(id)) setWork(entryCache.get(id)!);
            setWorkError("");
        }
        if (options.restore) restore.current = { y: returnScroll.current, focus: route.id ?? undefined };
        else if (!auto && id !== route.id) window.scrollTo({ top: 0, behavior: "instant" });
    }

    function link(event: MouseEvent<HTMLAnchorElement>, id: string | null, restorePosition = false) {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        unlock();
        navigate(id, { restore: restorePosition });
    }

    function changeFilter(name: string, value: string) {
        const next = new URLSearchParams(route.search);
        if (value) next.set(name, value); else next.delete(name);
        if (name !== "page") next.delete("page");
        const search = next.size ? `?${next}` : "";
        navigate(route.id, { search, replace: name === "q" });
        if (name === "page") gallery.current?.scrollIntoView({ block: "start" });
    }

    useEffect(() => {
        history.scrollRestoration = "manual";
        const onPop = () => {
            setShuffle(false);
            focusPlayer.current = false;
            returnScroll.current = history.state?.returnScroll ?? 0;
            restore.current = { y: history.state?.scroll ?? 0, focus: history.state?.returnId };
            const next = readRoute();
            setRoute(next);
            setWork(next.id ? entryCache.get(next.id) ?? null : null);
        };
        const legacy = () => {
            const id = location.hash.slice(1);
            if (/^[a-zA-Z0-9_-]+$/.test(id)) location.replace(workURL(id) + location.search);
        };
        legacy();
        window.addEventListener("popstate", onPop);
        window.addEventListener("hashchange", legacy);
        return () => { window.removeEventListener("popstate", onPop); window.removeEventListener("hashchange", legacy); };
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        setError("");
        json<CatalogIndex>("/works/catalog.json", controller.signal).then(setIndex).catch(error => {
            if (!controller.signal.aborted) { setError(error.message); setLoading(false); }
        });
        return () => controller.abort();
    }, [retry]);

    useEffect(() => {
        if (!index) return;
        const controller = new AbortController();
        setLoading(true);
        setError("");
        const paths = [...new Set(visible.map(item => item.chunk))];
        Promise.all(paths.map(async path => {
            if (chunks.has(path)) return chunks.get(path)!;
            const entries = await json<CatalogEntry[]>(path, controller.signal);
            chunks.set(path, entries);
            if (chunks.size > 16) chunks.delete(chunks.keys().next().value!);
            return entries;
        })).then(groups => {
            if (controller.signal.aborted) return;
            const byId = new Map(groups.flat().map(entry => [entry.id, entry]));
            const entries = visible.map(item => byId.get(item.id)!);
            if (entries.some(entry => !entry)) throw new Error("一覧が更新されました。再読み込みしてください。");
            for (const entry of entries) entryCache.set(entry.id, entry);
            while (entryCache.size > 96) entryCache.delete(entryCache.keys().next().value!);
            setCards(entries);
            setLoading(false);
        }).catch(error => {
            if (!controller.signal.aborted) { setError(error.message); setLoading(false); }
        });
        return () => controller.abort();
    }, [index, visible]);

    useEffect(() => {
        const controller = new AbortController();
        setWorkError("");
        if (!route.id) { setWork(null); return; }
        const cached = entryCache.get(route.id);
        if (cached) { setWork(cached); return; }
        json<CatalogEntry>(`/works/${encodeURIComponent(route.id)}/meta.json`, controller.signal).then(entry => {
            if (!controller.signal.aborted) { entryCache.set(entry.id, entry); setWork(entry); }
        }).catch(error => { if (!controller.signal.aborted) { setWorkError(error.message); setShuffle(false); } });
        return () => controller.abort();
    }, [route.id, retry]);

    useEffect(() => { updateDescription(work); }, [work]);

    useEffect(() => {
        if (loading || !restore.current || (route.id && work?.id !== route.id && !workError)) return;
        const saved = restore.current;
        const request = requestAnimationFrame(() => {
            window.scrollTo({ top: saved.y, behavior: "instant" });
            if (saved.focus) document.querySelector<HTMLAnchorElement>(`[data-work="${saved.focus}"]`)?.focus({ preventScroll: true });
            restore.current = null;
        });
        return () => cancelAnimationFrame(request);
    }, [loading, route, cards, work?.id, workError]);

    useEffect(() => {
        const active = frame.current;
        const forwarded = new Set<string>();
        const send = (code: string, down: boolean) => {
            active?.contentWindow?.postMessage({ fanm: "key", code, down }, location.origin);
            if (down) forwarded.add(code); else forwarded.delete(code);
        };
        const release = () => { for (const code of [...forwarded]) send(code, false); };
        const key = (event: KeyboardEvent) => {
            if (event.type === "keyup" && forwarded.has(event.code)) { send(event.code, false); return; }
            if (!active || event.ctrlKey || event.metaKey || event.altKey || !PLAY_KEYS.has(event.code)) return;
            if ((event.target as Element)?.closest?.("input, textarea, select, button, a, [contenteditable=true]")) return;
            if (!event.repeat) send(event.code, event.type === "keydown");
            event.preventDefault();
        };
        const wake = () => { unlock(); active?.contentWindow?.postMessage({ fanm: "audio" }, location.origin); };
        window.addEventListener("keydown", key);
        window.addEventListener("keyup", key);
        window.addEventListener("blur", release);
        window.addEventListener("pointerdown", wake);
        return () => {
            release();
            window.removeEventListener("keydown", key); window.removeEventListener("keyup", key);
            window.removeEventListener("blur", release); window.removeEventListener("pointerdown", wake);
        };
    }, [work?.id]);

    function randomNext(auto: boolean) {
        if (!index?.items.length) return;
        const pool = index.items.filter(item => item.id !== route.id);
        const item = pool[Math.floor(Math.random() * pool.length)] ?? index.items[0];
        navigate(item.id, { auto });
    }
    useEffect(() => {
        if (!shuffle || !work) return;
        const timer = window.setTimeout(() => randomNext(true), 60_000);
        return () => clearTimeout(timer);
    }, [shuffle, work?.id, index, route.search]);

    return <>
        {createPortal(<>
        <div className="toolbar">
            <button id="random" disabled={!index?.items.length} aria-pressed={shuffle} onClick={() => {
                unlock();
                if (shuffle) setShuffle(false);
                else { randomNext(false); setShuffle(true); }
            }}>{shuffle ? "ランダム再生中" : "ランダム再生"}</button>
        </div>
        {route.id && <section id="stage" ref={stage} aria-label="作品の再生">
            <div className="player-actions">
                {selectedAt > 0 && <a href={workURL(index!.items[selectedAt - 1].id) + route.search} onClick={event => link(event, index!.items[selectedAt - 1].id)}>次の作品</a>}
                <a id="close" href={`/${route.search}`} onClick={event => link(event, null, true)}>一覧に戻る</a>
                {selectedAt >= 0 && selectedAt < index!.items.length - 1 && <a href={workURL(index!.items[selectedAt + 1].id) + route.search} onClick={event => link(event, index!.items[selectedAt + 1].id)}>前の作品</a>}
            </div>
            {workError ? <p className="error" role="alert">{workError} <button onClick={() => setRetry(value => value + 1)}>再読み込み</button></p> : work ? <>
                {work.controls && <p className="status">操作：{work.controls}</p>}
                <iframe key={work.id} ref={frame} title={work.title} allow="autoplay" src={`/play.html?work=${encodeURIComponent(work.id)}`} onLoad={() => {
                    if (focusPlayer.current) frame.current?.contentWindow?.focus();
                    frame.current?.contentWindow?.postMessage({ fanm: "audio" }, location.origin);
                }} />
            </> : <p role="status">作品を読み込んでいます…</p>}
        </section>}
        </>, document.querySelector("#player")!)}
        <section id="catalog-region" ref={gallery} aria-labelledby="catalog-heading">
            <h2 id="catalog-heading">{route.id ? "ほかの作品" : "作品一覧"}</h2>
            <div className="top-toolbar">
                <div className="filters">
                    <label>作品を検索<input type="search" value={query} placeholder="タイトル・作者・モデル名" onChange={event => changeFilter("q", event.target.value)} /></label>
                    <label>公開月<select value={month} onChange={event => changeFilter("month", event.target.value)}><option value="">すべて</option>{months.map(value => <option key={value}>{value}</option>)}</select></label>
                    <label>並び順<select value={oldest ? "oldest" : "newest"} onChange={event => changeFilter("order", event.target.value)}><option value="newest">新しい順</option><option value="oldest">古い順</option></select></label>
                </div>
                <nav className="pagination" aria-label="作品一覧のページ">
                    <button disabled={page <= 1 || loading} onClick={() => changeFilter("page", String(page - 1))}>前のページ</button>
                    <span>{page} / {pages}</span>
                    <button disabled={page >= pages || loading} onClick={() => changeFilter("page", String(page + 1))}>次のページ</button>
                </nav>
            </div>
            <p className="status" aria-live="polite">{index ? `${filtered.length} 作品・${page} / ${pages} ページ` : "一覧を読み込んでいます…"}</p>
            {error && <p className="error" role="alert">{error} <button onClick={() => { chunks.clear(); setRetry(value => value + 1); }}>再読み込み</button></p>}
            {loading ? <p role="status">読み込んでいます…</p> : !error && !cards.length ? <p>該当する作品がありません。</p> : <ul id="catalog">{cards.map(entry => <li key={entry.id}>
                <a className="card" data-work={entry.id} aria-current={entry.id === route.id ? "true" : undefined} href={workURL(entry.id) + route.search} onClick={event => link(event, entry.id)}>
                    <span className="crt"><img src={entry.thumb} alt="" loading="lazy" /></span>
                    <strong>{entry.title}</strong><span>{entry.description}</span>
                    <small className="foot"><time dateTime={entry.createdAt}>{date(entry.createdAt)}</time>{entry.model && <span className="model">{entry.penName && <b className="pen">{entry.penName}</b>}{entry.model}</span>}</small>
                </a>
            </li>)}</ul>}
            <nav className="pagination" aria-label="作品一覧のページ">
                <button disabled={page <= 1 || loading} onClick={() => changeFilter("page", String(page - 1))}>前のページ</button>
                <span>{page} / {pages}</span>
                <button disabled={page >= pages || loading} onClick={() => changeFilter("page", String(page + 1))}>次のページ</button>
            </nav>
        </section>
    </>;
}

createRoot(document.querySelector("#gallery")!).render(<App />);
