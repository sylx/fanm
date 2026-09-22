import { expect, test, type Page } from "@playwright/test";
import { catalogFiles } from "../server/catalog.js";
import type { CatalogEntry, CatalogIndex } from "../src/catalog-entry.js";

async function fixture(page: Page) {
    const response = await page.request.get("/works/catalog.json");
    const index = await response.json() as CatalogIndex;
    test.skip(!index.items.length, "var/works にプレビュー用作品が必要です");
    const real = await (await page.request.get(`/works/${index.items.at(-1)!.id}/meta.json`)).json() as CatalogEntry;
    const entries = [real, ...Array.from({ length: 1000 }, (_, i) => ({
        ...real, id: `fixture-${i}`, title: `作品 ${i}`, createdAt: new Date(Date.UTC(2027, 0, 1) + i * 60_000).toISOString()
    }))];
    const { files } = catalogFiles(entries);
    await page.route("**/works/**", async route => {
        const path = new URL(route.request().url()).pathname;
        const data = files.get(path);
        if (data) return route.fulfill({ contentType: "application/json", body: data });
        return route.continue();
    });
    // 一覧・遷移のテストでは生成作品の計算負荷から切り離す。実再生は別途確認する。
    await page.route("**/play.html?*", route => route.fulfill({ contentType: "text/html", body: "<html><body>player</body></html>" }));
    return real;
}

test("最古の直リンクでも24件。検索・ページ操作でプレイヤーを作り直さない", async ({ page }) => {
    const real = await fixture(page);
    const requests: string[] = [];
    page.on("request", request => requests.push(request.url()));
    await page.goto(`/work/${real.id}/`);
    await expect(page.locator("#catalog .card")).toHaveCount(24);
    await expect(page.locator("#work-title")).toHaveText(real.title);
    const player = page.locator("#stage iframe");
    await expect(player).toHaveAttribute("src", `/play.html?work=${real.id}`);
    await player.evaluate(element => element.setAttribute("data-kept", "yes"));
    await page.getByRole("button", { name: "次のページ" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.locator("#catalog .card")).toHaveCount(24);
    await expect(player).toHaveAttribute("data-kept", "yes");
    await page.getByRole("searchbox").fill("作品 999");
    await expect(page.locator("#catalog .card")).toHaveCount(1);
    await expect(player).toHaveAttribute("data-kept", "yes");
    expect(requests.some(url => url.includes("/works/index.json"))).toBe(false);
});

test("一覧のページと位置を復元し、ブラウザの戻る・進むでも再生を切り替える", async ({ page }) => {
    await fixture(page);
    await page.goto("/?page=2");
    await expect(page.locator("#catalog .card")).toHaveCount(24);
    const card = page.locator("#catalog .card").nth(12);
    await card.scrollIntoViewIfNeeded();
    const y = await page.evaluate(() => window.scrollY);
    await card.click();
    await expect(page.locator("#stage iframe")).toBeVisible();
    await page.getByRole("link", { name: "一覧に戻る" }).click();
    await expect(page).toHaveURL(/\/\?page=2$/);
    await expect(page.locator("#stage iframe")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(y, 0);
    await page.goBack();
    await expect(page.locator("#stage iframe")).toHaveCount(1);
    await page.goBack();
    await expect(page.locator("#stage iframe")).toHaveCount(0);
    await page.goForward();
    await expect(page.locator("#stage iframe")).toHaveCount(1);
});

test("旧ハッシュURLを新URLへ移し、ランダム再生でも一覧を増やさない", async ({ page }) => {
    const real = await fixture(page);
    await page.clock.install();
    await page.goto(`/#${real.id}`);
    await expect(page).toHaveURL(new RegExp(`/work/${real.id}/$`));
    await expect(page.locator("#catalog .card")).toHaveCount(24);
    await page.getByRole("button", { name: "ランダム再生", exact: true }).click();
    await expect(page.getByRole("button", { name: "ランダム再生中" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#catalog .card")).toHaveCount(24);
    await expect(page.locator("#stage iframe")).toHaveCount(1);
    await page.getByRole("searchbox").focus();
    const before = await page.evaluate(() => ({ url: location.href, history: history.length, y: scrollY }));
    await page.clock.fastForward(60_001);
    await expect.poll(() => page.url()).not.toBe(before.url);
    await expect(page.getByRole("searchbox")).toBeFocused();
    expect(await page.evaluate(() => history.length)).toBe(before.history);
    expect(await page.evaluate(() => scrollY)).toBe(before.y);
    await expect(page.locator("#catalog .card")).toHaveCount(24);
});

test("開発サーバーも初回HTMLにOGPを返し、手元の未ビルド作品を再生できる", async ({ page }) => {
    const index = await (await page.request.get("/works/catalog.json")).json() as CatalogIndex;
    test.skip(!index.items.length, "var/works にプレビュー用作品が必要です");
    const id = index.items[0].id;
    const response = await page.request.get(`/work/${id}/`);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain(`https://fanm.oyabanare.com/work/${id}/`);
    const redirect = await page.request.get(`/work/${id}`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(308);
    expect(redirect.headers().location).toBe(new URL(`/work/${id}/`, response.url()).href);
    await page.goto(`/work/${id}/`);
    const canvas = page.frameLocator("#stage iframe").locator("canvas");
    await expect(canvas).toBeVisible();
    await expect.poll(() => canvas.evaluate(element => (element as HTMLCanvasElement).width % 272)).toBe(0);
    await expect(page.frameLocator("#stage iframe").locator("#error")).toHaveCount(0);
    const missing = await page.request.get("/work/does-not-exist/");
    expect(missing.status()).toBe(404);
});

test("スマホでも作品と一覧が横にはみ出さない", async ({ page }) => {
    const real = await fixture(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/work/${real.id}/`);
    await expect(page.locator("#catalog .card")).toHaveCount(24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.screenshot({ path: "var/gallery-test-results/mobile.png", fullPage: false });
});
