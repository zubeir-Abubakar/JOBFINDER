import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_VOICE_PROFILES, LIVE_VOICE_IDS, applyVoiceOverride, supportedVoices, voiceProfileForAgent } from "../lib/agent-voices";

test("the supported voice list is the existing Gemini Live set, with no invented IDs", () => {
  const voices = supportedVoices();
  assert.equal(voices.length, LIVE_VOICE_IDS.length);
  assert.deepEqual(voices.map((voice) => voice.voiceId), [...LIVE_VOICE_IDS]);
  for (const voice of voices) {
    assert.ok(LIVE_VOICE_IDS.includes(voice.voiceId));
    assert.ok(voice.voiceName.startsWith(`${voice.voiceId} —`));
  }
});

test("changing one agent's voice leaves every other agent untouched", () => {
  const before = new Map(Object.entries(AGENT_VOICE_PROFILES).map(([key, profile]) => [key, { ...profile }]));
  const overridden = applyVoiceOverride(voiceProfileForAgent("research"), { research: "Kore" });
  assert.equal(overridden.voiceId, "Kore");
  assert.match(overridden.voiceName, /^Kore —/);
  assert.equal(voiceProfileForAgent("research").voiceId, "Leda", "the configured default is not mutated");
  assert.equal(voiceProfileForAgent("application").voiceId, "Orus");
  for (const [key, profile] of before) {
    assert.equal(voiceProfileForAgent(key).voiceId, profile.voiceId, `${key} changed unexpectedly`);
    assert.equal(voiceProfileForAgent(key).voiceName, profile.voiceName);
    assert.equal(voiceProfileForAgent(key).provider, profile.provider);
    assert.equal(voiceProfileForAgent(key).style, profile.style);
  }
});

test("invalid or unknown overrides are ignored instead of inventing a voice", () => {
  const source = voiceProfileForAgent("email");
  assert.equal(applyVoiceOverride(source, { email: "NotARealVoice" }).voiceId, source.voiceId);
  assert.equal(applyVoiceOverride(source, {}).voiceId, source.voiceId);
  assert.equal(applyVoiceOverride(source, { research: "Kore" }).voiceId, "Zephyr");
});
