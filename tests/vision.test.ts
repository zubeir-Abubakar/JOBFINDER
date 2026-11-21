import test from "node:test";
import assert from "node:assert/strict";

process.env.VISION_ENABLED = "true";
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

test("only a bounded base64 image data URL is accepted", () => {
  const parsed = parseImageDataUrl("data:image/png;base64,iVBORw0KGgo=");
  assert.equal(parsed.mimeType, "image/png");
  assert.ok(parsed.bytes > 0);
  assert.throws(() => parseImageDataUrl("https://example.com/screenshot.png"), VisionUnavailableError);
  assert.throws(() => parseImageDataUrl("data:text/html;base64,PGgxPg=="), VisionUnavailableError);
});
