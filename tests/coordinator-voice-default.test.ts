import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { AGENT_VOICE_PROFILES } from "../lib/agent-voices.ts";
import {
  LIVE_VOICE_SESSION_KEY,
  parseStoredVoiceSession,
  resumableCoordinatorSession,
  serializeVoiceSession,
} from "../lib/voice-session.ts";

test("only a Coordinator-labelled live session may be resumed by the global launcher", () => {
  const coordinator = serializeVoiceSession("voice_abc123", "coordinator");
  assert.equal(resumableCoordinatorSession(coordinator), "voice_abc123");
  assert.deepEqual(parseStoredVoiceSession(coordinator), { sessionId: "voice_abc123", agentKey: "coordinator" });

  const specialist = serializeVoiceSession("voice_noor123", "application");
  assert.equal(resumableCoordinatorSession(specialist), null);
  assert.deepEqual(parseStoredVoiceSession(specialist), { sessionId: "voice_noor123", agentKey: "application" });
});

test("legacy or malformed session ids are discarded instead of being trusted", () => {
  assert.equal(resumableCoordinatorSession("voice_legacy123"), null);
  assert.equal(resumableCoordinatorSession(null), null);
  assert.equal(resumableCoordinatorSession(""), null);
  assert.equal(resumableCoordinatorSession("{bad json"), null);
  assert.equal(resumableCoordinatorSession(JSON.stringify({ sessionId: "voice_ok123", agentKey: "intruder" })), null);
  assert.equal(resumableCoordinatorSession(JSON.stringify({ sessionId: "bad", agentKey: "coordinator" })), null);
  assert.equal(resumableCoordinatorSession(JSON.stringify({ sessionId: "voice_ok123" })), null);
});

test("the launcher is wired to the Coordinator and no longer adopts the text-agent session", () => {
  assert.equal(LIVE_VOICE_SESSION_KEY, "atw.live.session.v2");
  const shell = readFileSync("components/AppShell.tsx", "utf8");
  const layout = readFileSync("app/(app)/layout.tsx", "utf8");
  const launcher = readFileSync("components/CoordinatorLiveVoice.tsx", "utf8");
  assert.doesNotMatch(shell, /activeAgentKey=/);
  assert.doesNotMatch(layout, /activeAgentSession/);
  assert.match(launcher, /void startLive\("coordinator", \{ greet: true, fresh: true, preserveMessages: false \}\)/);
  assert.match(launcher, /resumableCoordinatorSession/);
  assert.match(launcher, /serializeVoiceSession\(payload\.sessionId, payload\.agentKey\)/);
});

test("every existing agent voice assignment is unchanged", () => {
  const expected = {
    coordinator: "Charon",
    research: "Leda",
    analysis: "Fenrir",
    cv: "Kore",
    ats: "Puck",
    cover: "Aoede",
    application: "Orus",
    email: "Zephyr",
  } as const;
  for (const [agentKey, voiceId] of Object.entries(expected)) {
    const profile = AGENT_VOICE_PROFILES[agentKey as keyof typeof AGENT_VOICE_PROFILES];
    assert.equal(profile.voiceId, voiceId, `${agentKey} voice changed`);
    assert.equal(profile.provider, "gemini-live");
    assert.equal(profile.available, true);
  }
});
