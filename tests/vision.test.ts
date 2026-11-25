import test from "node:test";
import assert from "node:assert/strict";
import { geminiEvidence } from "./helpers/free-tier-evidence.ts";

process.env.VISION_ENABLED = "true";
process.env.GEMINI_FREE_TIER_EVIDENCE = geminiEvidence(["gemini-3.6-flash"]);
delete process.env.GEMINI_API_KEY;
delete process.env.VISION_MODEL;

const { visionConfig, visionCapability, parseImageDataUrl, VisionUnavailableError } = await import("../lib/vision.ts");

test("vision is reported unavailable when no image-capable key is configured", () => {
  const config = visionConfig();
  assert.equal(config.configured, false);
  assert.equal(config.provider, null);
  assert.match(config.detail, /GEMINI_API_KEY/);
  assert.match(config.detail, /GPT-OSS-20B is text-only/);
});

test("an explicit disable is truthful and mentions no transmission", () => {
  process.env.VISION_ENABLED = "false";
  const capability = visionCapability();
  assert.equal(capability.enabled, false);
  assert.match(capability.detail, /not sent/);
  process.env.VISION_ENABLED = "true";
});

test("free-tier Gemini vision is enabled without inventing a cost", () => {
  const saved = new Map(
    ["GEMINI_API_KEY", "GEMINI_PAID_AUTHORISED", "GEMINI_FREE_TIER_VERIFIED", "VISION_MODEL", "GEMINI_MODEL"].map((key) => [key, process.env[key]]),
  );
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.GEMINI_FREE_TIER_VERIFIED = "true";
  process.env.VISION_MODEL = "gemini-3.6-flash";
  try {
    const capability = visionCapability();
    assert.equal(capability.enabled, true);
    assert.equal(capability.configured, true);
    assert.equal(capability.blockedByPolicy, false);
    assert.equal(capability.model, "gemini-3.6-flash");
    assert.match(capability.detail, /free tier/i);
    assert.doesNotMatch(capability.detail, /CHF\s*0\.00|owner-authorised/i);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("only a bounded base64 image data URL is accepted", () => {
  const parsed = parseImageDataUrl("data:image/png;base64,iVBORw0KGgo=");
  assert.equal(parsed.mimeType, "image/png");
  assert.ok(parsed.bytes > 0);
  assert.throws(() => parseImageDataUrl("https://example.com/screenshot.png"), VisionUnavailableError);
  assert.throws(() => parseImageDataUrl("data:text/html;base64,PGgxPg=="), VisionUnavailableError);
});
