import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./test",
    testMatch: "*.spec.ts",
    use: { baseURL: process.env.FANM_GALLERY_URL ?? "http://localhost:5173", browserName: "chromium" },
    webServer: process.env.FANM_GALLERY_URL ? undefined : { command: "npm run gallery:dev", cwd: "../..", url: "http://localhost:5173", reuseExistingServer: true },
    outputDir: "../../var/gallery-test-results"
});
