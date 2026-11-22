import { test, expect, gotoReady } from "./support/fixtures";
import { AGENT_IDENTITIES } from "./support/constants";

test("mobile dashboard and agent roster render without horizontal overflow", async ({ page, diagnostics }) => {
  await gotoReady(page, "/dashboard");
  await expect(page.getByText("Active opportunities")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page must not overflow horizontally at 390px").toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Agents", exact: true }).click();
  await page.waitForURL("**/agents");
  await expect(page.getByTestId("agent-topology")).toBeVisible();
  const topologyOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(topologyOverflow, "topology must not overflow horizontally at 390px").toBeLessThanOrEqual(1);

  const views = page.getByRole("navigation", { name: "Agents views" });
  await views.getByRole("link", { name: "List view" }).click();
  await page.waitForURL("**/agents/list");
  await expect(page.locator(".agent-card")).toHaveCount(8);
  for (const identity of AGENT_IDENTITIES) {
    await expect(page.getByText(identity.name, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Open AT Voice Assistant" })).toBeVisible();
  diagnostics.assertClean();
});

test("the conversation composer, agent switch and live-voice control remain usable across supported viewports", async ({ page, diagnostics }) => {
  await gotoReady(page, "/assistant");

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 1280, height: 800 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
    { width: 360, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole("button", { name: "Open AT Voice Assistant" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open AT Voice Assistant" })).toBeInViewport();
    await expect(page.getByLabel("Switch direct agent")).toBeVisible();
    // The conversation is a normal scrolling document. Bring the composer into
    // view and verify its actual usable geometry; being below the fold is not
    // clipping when nothing prevents scrolling to it.
    await page.getByLabel("Message the assistant").scrollIntoViewIfNeeded();
    await expect(page.getByLabel("Message the assistant")).toBeInViewport();
    await expect(page.getByRole("button", { name: /^Send$/ })).toBeInViewport();

    const geometry = await page.evaluate(() => {
      const composer = document.querySelector('textarea[aria-label="Message the assistant"]')?.getBoundingClientRect();
      const send = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Send")?.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        composer: composer ? { top: composer.top, bottom: composer.bottom, left: composer.left, right: composer.right } : null,
        send: send ? { top: send.top, bottom: send.bottom, left: send.left, right: send.right } : null,
        width: window.innerWidth,
        height: window.innerHeight,
      };
    });
    expect(geometry.overflow, `horizontal overflow at ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(1);
    expect(geometry.composer).not.toBeNull();
    expect(geometry.send).not.toBeNull();
    for (const [name, rect] of Object.entries({ composer: geometry.composer, send: geometry.send })) {
      expect(rect!.left, `${name} clipped on the left at ${viewport.width}px`).toBeGreaterThanOrEqual(0);
      expect(rect!.right, `${name} clipped on the right at ${viewport.width}px`).toBeLessThanOrEqual(geometry.width + 1);
      expect(rect!.top, `${name} above the viewport at ${viewport.height}px`).toBeGreaterThanOrEqual(0);
      expect(rect!.bottom, `${name} below the viewport at ${viewport.height}px`).toBeLessThanOrEqual(geometry.height + 1);
    }
  }
  diagnostics.assertClean();
});
