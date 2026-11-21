import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3313);
const baseURL = `http://127.0.0.1:${port}`;
const ownerState = path.join(process.cwd(), ".e2e-runtime/auth/owner.json");
const adminState = path.join(process.cwd(), ".e2e-runtime/auth/admin.json");
const voiceFixture = path.join(process.cwd(), "e2e/fixtures/voice-question.wav");

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 1,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
  ],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 35_000,
    testIdAttribute: "data-testid",
  },
  webServer: {
    command: "node e2e/start-server.mjs",
    url: `${baseURL}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      E2E_PORT: String(port),
      E2E_JOB_PORT: "3314",
    },
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL },
    },
    {
      name: "desktop-chromium",
      dependencies: ["setup"],
      testIgnore: [/auth\.setup\.ts/, /auth\.spec\.ts/, /mobile\.spec\.ts/, /voice.*\.spec\.ts/, /visual\.spec\.ts/, /schedules\.spec\.ts/, /admin\.spec\.ts/, /integration\//],
      use: {
        ...devices["Desktop Chrome"],
        baseURL,
        storageState: ownerState,
        viewport: { width: 1440, height: 960 },
      },
    },
    {
      name: "auth-chromium",
      dependencies: ["setup"],
      testMatch: /auth\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL, storageState: { cookies: [], origins: [] } },
    },
    {
      name: "mobile-chromium",
      dependencies: ["setup"],
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Pixel 7"],
        baseURL,
        storageState: ownerState,
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: "voice-chromium",
      dependencies: ["setup"],
      testMatch: /voice.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL,
        storageState: ownerState,
        permissions: ["microphone"],
        launchOptions: {
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            `--use-file-for-fake-audio-capture=${voiceFixture}`,
            "--autoplay-policy=no-user-gesture-required",
          ],
        },
      },
    },
    {
      name: "visual-chromium",
      dependencies: ["setup"],
      testMatch: /visual\.spec\.ts/,
      testIgnore: /voice-visual\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL,
        storageState: ownerState,
        viewport: { width: 1440, height: 960 },
        launchOptions: {
          args: [
            "--auto-select-desktop-capture-source=Entire screen",
            "--use-fake-ui-for-media-stream",
          ],
        },
      },
    },
    {
      name: "schedules-chromium",
      dependencies: ["setup"],
      testMatch: /schedules\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL,
        storageState: ownerState,
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "integration",
      testMatch: /integration\/.*\.spec\.ts/,
      use: { baseURL },
    },
    {
      name: "admin-chromium",
      dependencies: ["setup"],
      testMatch: /admin\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL,
        storageState: adminState,
        viewport: { width: 1440, height: 960 },
      },
    },
  ],
});
