import { test, expect, gotoReady } from "./support/fixtures";

test.describe.configure({ mode: "serial" });
test.setTimeout(150_000);

test("live voice starts a real audio pipeline, transmits mic audio, plays TTS and supports interruption", async ({ page, diagnostics }, testInfo) => {
  await page.addInitScript(() => {
    const metrics = {
      micCalls: 0,
      liveTracks: 0,
      playbackStarts: 0,
      playbackStops: 0,
      workletNodes: 0,
    };
    (window as unknown as { __e2eAudio: typeof metrics }).__e2eAudio = metrics;

    if (navigator.mediaDevices?.getUserMedia) {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        metrics.micCalls += 1;
        const stream = await original(constraints);
        const track = stream.getAudioTracks()[0];
        if (track?.readyState === "live") metrics.liveTracks += 1;
        track?.addEventListener("ended", () => {
          if (metrics.liveTracks > 0) metrics.liveTracks -= 1;
        });
        return stream;
      };
    }

    const OriginalSource = window.AudioBufferSourceNode;
    if (OriginalSource) {
      const originalStart = OriginalSource.prototype.start;
      OriginalSource.prototype.start = function (...args: Parameters<AudioBufferSourceNode["start"]>) {
        metrics.playbackStarts += 1;
        return originalStart.apply(this, args);
      };
      const originalStop = OriginalSource.prototype.stop;
      OriginalSource.prototype.stop = function (...args: Parameters<AudioBufferSourceNode["stop"]>) {
        metrics.playbackStops += 1;
        return originalStop.apply(this, args);
      };
    }

    const OriginalWorklet = window.AudioWorkletNode;
    if (OriginalWorklet) {
      class CountingWorklet extends OriginalWorklet {
        constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
          super(context, name, options);
          metrics.workletNodes += 1;
        }
      }
      window.AudioWorkletNode = CountingWorklet as typeof AudioWorkletNode;
    }
  });

  const sentFrames: string[] = [];
  const receivedFrames: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", (event) => sentFrames.push(String(event.payload)));
    socket.on("framereceived", (event) => receivedFrames.push(String(event.payload)));
  });

  // The server persists the active agent between browser contexts. Reset to
  // the Coordinator so this voice test never depends on test execution order.
  const reset = await page.request.post("/api/assistant/message", { data: { message: "Take me back to Chief." } });
  expect(reset.ok()).toBe(true);
  await gotoReady(page, "/assistant");
  await page.getByRole("button", { name: "Open AT Voice Assistant" }).click();
  const panel = page.locator(".lv-panel");
  await expect(panel).toBeVisible();

  await expect
    .poll(async () => await panel.locator(".lv-status").innerText(), { timeout: 35_000 })
    .toMatch(/Listening|Speaking|Unavailable/i);

  const statusText = await panel.locator(".lv-status").innerText();
  if (/Unavailable/i.test(statusText)) {
    const alert = await panel.locator(".lv-alert").innerText().catch(() => "");
    if (/not configured|quota|billing|permission|free-tier|timed out|network/i.test(alert)) {
      testInfo.annotations.push({ type: "BLOCKED", description: `Live Gemini voice unavailable: ${alert.slice(0, 240)}` });
      test.skip(true, `Live voice provider unavailable in this environment: ${alert.slice(0, 180)}`);
    }
    throw new Error(`Voice failed for a non-configuration reason: ${alert}`);
  }

  await expect(page.locator(".lv-panel")).toContainText(/Application Agent \/ Submission|Chief Coordinator \/ Orchestrator/i);
  await expect(page.locator(".lv-mic")).toHaveText(/Mic live/i);

  const diagnosticEvents = async () =>
    page.evaluate(() => (window as unknown as { __atwVoiceDiagnostics?: { events: Array<{ event: string }> } }).__atwVoiceDiagnostics?.events.map((entry) => entry.event) ?? []);
  for (const stage of [
    "MIC_PERMISSION_REQUESTED",
    "MIC_STREAM_ACTIVE",
    "AUDIOWORKLET_READY",
    "LIVE_SESSION_CONNECTED",
    "INPUT_FRAMES_GENERATED",
    "INPUT_FRAMES_SENT",
    "OUTPUT_AUDIO_RECEIVED",
    "AUDIO_PLAYBACK_STARTED",
  ]) {
    await expect.poll(async () => (await diagnosticEvents()).includes(stage), { timeout: 30_000 }).toBe(true);
  }
  const safeDiagnostics = await page.evaluate(() =>
    JSON.stringify((window as unknown as { __atwVoiceDiagnostics?: unknown }).__atwVoiceDiagnostics ?? {}),
  );
  expect(safeDiagnostics).not.toMatch(/audio\/pcm|access_token|wsUrl|Authorization/i);

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const metrics = (window as unknown as { __e2eAudio: { micCalls: number; liveTracks: number; playbackStarts: number } }).__e2eAudio;
          return metrics;
        }),
      { timeout: 20_000, intervals: [250, 500, 1000] },
    )
    .toMatchObject({ micCalls: 1 });

  const metrics = await page.evaluate(
    () => (window as unknown as { __e2eAudio: { micCalls: number; liveTracks: number; playbackStarts: number; workletNodes: number } }).__e2eAudio,
  );
  expect(metrics.liveTracks).toBe(1);
  expect(metrics.workletNodes).toBeGreaterThanOrEqual(1);

  await expect
    .poll(() => sentFrames.filter((frame) => frame.includes('"realtimeInput"') && frame.includes('"audio"')).length, {
      timeout: 25_000,
    })
    .toBeGreaterThan(0);
  expect(receivedFrames.some((frame) => /setupComplete|serverContent|sessionResumptionUpdate/.test(frame))).toBe(true);

  // The provider sends a spoken introduction; this proves real TTS audio
  // reached the Web Audio playback path, not just that the dialog opened.
  // Read the live browser object: a metrics snapshot never updates.
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __e2eAudio: { playbackStarts: number } }).__e2eAudio.playbackStarts,
        ),
      { timeout: 35_000 },
    )
    .toBeGreaterThan(0);
  await expect
    .poll(async () => await page.locator(".lv-panel").innerText(), { timeout: 35_000 })
    .toMatch(/Chief —/);

  // Input transcription is the direct evidence that the fake microphone's
  // speech reached Gemini. A connected WebSocket alone is not enough.
  await expect
    .poll(async () => (await diagnosticEvents()).includes("USER_SPEECH_RECEIVED"), { timeout: 40_000 })
    .toBe(true);
  await expect(page.getByTestId("voice-speech-received")).toBeVisible();
  await expect(panel.locator(".lv-msg.is-user").first()).toBeVisible();

  const interrupt = panel.getByRole("button", { name: "Interrupt" });
  await expect
    .poll(async () => (await interrupt.isEnabled()) || /Interrupted/i.test(await panel.innerText()), { timeout: 30_000 })
    .toBe(true);
  if (await interrupt.isEnabled()) {
    await interrupt.click();
    // The UI intentionally returns to Listening as soon as the interrupted
    // turn is cleared, so asserting a transient “Interrupted” label is racy.
    // Prove the queued Web Audio sources were stopped and playback left Speaking.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as { __e2eAudio: { playbackStops: number } }).__e2eAudio.playbackStops,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    await expect.poll(async () => await panel.locator(".lv-status").innerText(), { timeout: 15_000 }).toMatch(/Listening|Interrupted/);
    await expect.poll(async () => (await diagnosticEvents()).includes("INTERRUPTION_DETECTED"), { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => (await diagnosticEvents()).includes("LISTENING_RESUMED"), { timeout: 10_000 }).toBe(true);
  }
  await expect(panel.locator(".lv-presence")).toContainText("Connected");
  await panel.getByRole("button", { name: "End", exact: true }).click();
  await expect(panel.locator(".lv-status")).toContainText("Disconnected");

  diagnostics.assertClean();
});
