import { test, expect, gotoReady } from "./support/fixtures";
import { one } from "./support/db";

test("duplicate voice transcripts and their token usage are persisted once", async ({ page, diagnostics }) => {
  await gotoReady(page, "/assistant");
  const sessionId = `voice_dedupe_${Date.now()}`;
  const turnId = "turn-duplicate-1";
  const base = {
    sessionId,
    turnId,
    content: "Synthetic duplicate transcript.",
    agentKey: "coordinator",
    taskIds: [],
    interrupted: false,
    model: "gemini-3.8-live",
  };

  const first = await page.request.post("/api/voice/live/transcript", {
    data: { ...base, role: "assistant", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } },
  });
  expect(first.ok()).toBe(true);
  expect(await first.json()).toMatchObject({ ok: true });

  const duplicate = await page.request.post("/api/voice/live/transcript", {
    data: { ...base, role: "assistant", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } },
  });
  expect(duplicate.ok()).toBe(true);
  expect(await duplicate.json()).toMatchObject({ ok: true, duplicate: true });

  const rows = await import("./support/db").then(({ query }) =>
    query<{ id: number }>("SELECT id FROM chat_messages WHERE meta LIKE ?", `%\"voiceKey\":\"${sessionId}:${turnId}:assistant\"%`),
  );
  expect(rows).toHaveLength(1);

  const usageRows = await import("./support/db").then(({ query }) =>
    query<{ total_tokens: number }>("SELECT total_tokens FROM provider_usage WHERE session_id = ? AND provider = 'gemini-live'", sessionId),
  );
  expect(usageRows).toHaveLength(1);
  expect(usageRows[0].total_tokens).toBe(120);
  expect(one<{ c: number }>("SELECT COUNT(*) AS c FROM chat_messages WHERE meta LIKE ?", `%\"voiceKey\":\"${sessionId}:${turnId}:assistant\"%`)?.c).toBe(1);
  diagnostics.assertClean();
});
