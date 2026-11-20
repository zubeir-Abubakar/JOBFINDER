import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isIntentionalBargeIn, isStableConnection, mergeTranscript, reconnectDelay } from "../lib/voice-stream.ts";

test("duplicate model-turn and transcription text is not replayed twice", () => {
  assert.equal(mergeTranscript("Hello, Boss.", "Hello, Boss."), "Hello, Boss.");
  assert.equal(mergeTranscript("Hello", "Hello, Boss."), "Hello, Boss.");
  assert.equal(mergeTranscript("Hello, ", "Boss."), "Hello, Boss.");
  assert.equal(mergeTranscript("", "Hi."), "Hi.");
});

test("a short echo or pause does not interrupt agent speech", () => {
  assert.equal(isIntentionalBargeIn({ level: 0.2, frames: 2, speakingMs: 900, state: "speaking", muted: false }), false);
  assert.equal(isIntentionalBargeIn({ level: 0.2, frames: 4, speakingMs: 300, state: "speaking", muted: false }), false);
  assert.equal(isIntentionalBargeIn({ level: 0.2, frames: 4, speakingMs: 800, state: "listening", muted: false }), false);
  assert.equal(isIntentionalBargeIn({ level: 0.2, frames: 4, speakingMs: 800, state: "speaking", muted: true }), false);
  assert.equal(isIntentionalBargeIn({ level: 0.2, frames: 4, speakingMs: 800, state: "speaking", muted: false }), false);
});

test("a sustained deliberate utterance after the echo guard is a barge-in", () => {
  assert.equal(isIntentionalBargeIn({ level: 0.12, frames: 12, speakingMs: 700, state: "speaking", muted: false }), true);
});

test("reconnect backoff is bounded, jittered and only reset after stability", () => {
  assert.ok(reconnectDelay(1, 0) >= 500);
  assert.ok(reconnectDelay(1, 0) < reconnectDelay(2, 0));
  assert.ok(reconnectDelay(2, 0) < reconnectDelay(3, 0));
  assert.ok(reconnectDelay(8, 1) <= 7200);
  assert.notEqual(reconnectDelay(2, 0), reconnectDelay(2, 1));
  assert.equal(isStableConnection(9_999), false);
  assert.equal(isStableConnection(10_000), true);
  assert.equal(isStableConnection(Number.NaN), false);
});

test("the voice client keeps one microphone stream and exposes stop controls", () => {
  const source = readFileSync("components/CoordinatorLiveVoice.tsx", "utf8");
  assert.match(source, /async function ensureMicrophone/);
  assert.match(source, /initialAgentKey = "coordinator"/);
  assert.match(source, /useState<AgentKey>\(initialAgentKey\)/);
  assert.match(source, /micStream\.current && micNode\.current\) return true/);
  assert.match(source, /function stopPlayback/);
  assert.match(source, /function interrupt/);
  assert.match(source, /function toggleMute/);
  assert.match(source, /markConnectionStableAfterDelay/);
  assert.match(source, /reconnectDelay\(reconnectAttempts\.current\)/);
  assert.match(source, /scheduleInterruptRecovery/);
  assert.match(source, /__atwVoiceDiagnostics/);
  assert.match(source, /USER_SPEECH_RECEIVED/);
  assert.match(source, /isIntentionalBargeIn/);
  assert.match(source, /mergeTranscript/);
  assert.match(source, /className="lv-backdrop"/);
  assert.match(source, /Text alternative|Open text assistant/);
});

test("agent switching cuts old playback, preserves history and keeps the microphone alive", () => {
  const source = readFileSync("components/CoordinatorLiveVoice.tsx", "utf8");
  assert.match(source, /async function performHandoff/);
  assert.match(source, /stopPlayback\(\);\n    setNotice\(`Switching to/);
  assert.match(source, /fresh: false, preserveMessages: true/);
  assert.doesNotMatch(source, /performHandoff[\s\S]{0,500}stopMicrophone/);
  assert.match(source, /activeAgentRef\.current = target/);
});

test("the server uses delayed end-of-turn detection and keeps a resumable session", () => {
  const source = readFileSync("lib/live-voice.ts", "utf8");
  assert.match(source, /silenceDurationMs: 1050/);
  assert.match(source, /prefixPaddingMs: 300/);
  assert.match(source, /END_SENSITIVITY_LOW/);
  assert.match(source, /START_SENSITIVITY_LOW/);
  assert.match(source, /sessionResumption: \{\}/);
  assert.match(source, /activityHandling: ActivityHandling\.START_OF_ACTIVITY_INTERRUPTS/);
  assert.doesNotMatch(source, /introduce yourself exactly/i);
  assert.match(source, /greet the owner naturally/i);
});
