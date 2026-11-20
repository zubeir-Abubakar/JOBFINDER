import { expect, test as base } from "@playwright/test";
import type { Page } from "@playwright/test";

export type RequestFailure = {
  url: string;
  method: string;
  error: string;
  sameOrigin: boolean;
};

export type BrowserDiagnostics = {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: RequestFailure[];
  serverErrors: Array<{ url: string; status: number; method: string }>;
  assertClean: () => void;
  snapshot: () => Record<string, unknown>;
};

function isSameOrigin(url: string, baseURL: string): boolean {
  try {
    return new URL(url).origin === new URL(baseURL).origin;
  } catch {
    return false;
  }
}

export const test = base.extend<{ diagnostics: BrowserDiagnostics }>({
  diagnostics: async ({ page, baseURL }, use, testInfo) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: RequestFailure[] = [];
    const serverErrors: Array<{ url: string; status: number; method: string }> = [];

    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText ?? "unknown network failure";
      // Navigation, React unmounts and EventSource teardown abort in-flight
      // requests routinely. Those are cancellations, not network failures.
      if (/ERR_ABORTED/.test(failure)) return;
      failedRequests.push({
        url: request.url(),
        method: request.method(),
        error: failure,
        sameOrigin: isSameOrigin(request.url(), baseURL ?? ""),
      });
    });
    page.on("response", (response) => {
      if (response.status() >= 500) {
        serverErrors.push({ url: response.url(), status: response.status(), method: response.request().method() });
      }
    });

    const snapshot = () => ({
      consoleErrors,
      pageErrors,
      failedRequests,
      serverErrors,
    });

    const diagnostics: BrowserDiagnostics = {
      consoleErrors,
      pageErrors,
      failedRequests,
      serverErrors,
      assertClean: () => {
        const relevantFailures = failedRequests.filter((item) => item.sameOrigin);
        const relevantServerErrors = serverErrors.filter((item) => isSameOrigin(item.url, baseURL ?? ""));
        expect(consoleErrors, `Browser console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
        expect(pageErrors, `Uncaught page errors:\n${pageErrors.join("\n")}`).toEqual([]);
        expect(relevantFailures, `Failed same-origin requests:\n${JSON.stringify(relevantFailures, null, 2)}`).toEqual([]);
        expect(relevantServerErrors, `Same-origin HTTP 5xx responses:\n${JSON.stringify(relevantServerErrors, null, 2)}`).toEqual([]);
      },
      snapshot,
    };

    await use(diagnostics);

    await testInfo.attach("browser-diagnostics", {
      body: JSON.stringify(snapshot(), null, 2),
      contentType: "application/json",
    });
  },
});

export { expect };

export async function gotoReady(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
}
