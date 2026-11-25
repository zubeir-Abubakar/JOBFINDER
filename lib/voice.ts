import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { TEMP_DIR } from "./db";
import { scrubProviderError } from "./providers";
import { authorizeAiRequest, markPolicyNetworkTransmitted } from "./ai-spending-policy";
import { findTempObject, registerTempObject, tempFilePath, ttlHours } from "./temp-store";
import {
  OPENROUTER_HEYGEN_VOICES,
  openRouterTtsConfig,
  openRouterTtsConfigured,
  openRouterTtsPolicyIssue,
  validateOpenRouterFreeModel,
} from "./openrouter";

/**
 * Voice adapter for the FreeLLMAPI gateway. The API key stays on the server:
 * transcriptions and speech are proxied through authenticated route handlers.
 * Verified against the local gateway on 2026-11-18 with
 * gemini-2.5-flash-preview-tts (voice Charon, WAV) and whisper-1 transcription.
 */

export type VoiceConfig = {
  configured: boolean;
  blockedByPolicy: boolean;
  baseUrl: string;
  ttsModel: string;
  voice: string;
  sttModel: string;
  issues: string[];
};

export class VoiceUnavailableError extends Error {
  kind: "unconfigured" | "provider" | "empty";
  constructor(kind: "unconfigured" | "provider" | "empty", message: string) {
    super(message);
    this.name = "VoiceUnavailableError";
    this.kind = kind;
  }
}

export function voiceConfig(): VoiceConfig {
  const baseUrl = (process.env.FREELLMAPI_BASE_URL ?? "").replace(/\/$/, "");
  const key = process.env.FREELLMAPI_API_KEY ?? "";
  const enabled = (process.env.FREELLMAPI_ENABLED ?? "false") === "true";
  const issues: string[] = [];
  if (!enabled) issues.push("FreeLLMAPI is disabled (FREELLMAPI_ENABLED=false).");
  if (!baseUrl) issues.push("FREELLMAPI_BASE_URL is not set.");
  if (!key) issues.push("The FreeLLMAPI API key is not configured.");
  const ttsModel = process.env.FREELLMAPI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
  const sttModel = process.env.FREELLMAPI_STT_MODEL || "whisper-1";
  const voiceAllowed = (process.env.FREELLMAPI_VOICE_ALLOWED_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  if (voiceAllowed.length > 0 && !voiceAllowed.includes(ttsModel)) {
    issues.push(`Speech model ${ttsModel} is not in FREELLMAPI_VOICE_ALLOWED_MODELS.`);
  }
  if (voiceAllowed.length > 0 && !voiceAllowed.includes(sttModel)) {
    issues.push(`Transcription model ${sttModel} is not in FREELLMAPI_VOICE_ALLOWED_MODELS.`);
  }
  return {
    configured: issues.length === 0,
    blockedByPolicy: true,
    baseUrl,
    ttsModel,
    voice: process.env.FREELLMAPI_TTS_VOICE || "Charon",
    sttModel,
    issues,
  };
}

export function cleanSpeechText(input: string): string {
  return input
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
}

/** Strip markdown-ish noise that reads badly aloud, without faking an accent. */
export function speechFriendly(input: string): string {
  return cleanSpeechText(
    input
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[#*_>`]/g, " ")
      .replace(/\[(.*?)\]\(.*?\)/g, "$1")
      .replace(/\bhttps?:\/\/\S+/g, "link"),
  ).slice(0, 700);
}

function ttsCacheId(text: string, voice: string, speed: number, model: string): string {
  return `tts_${createHash("sha256").update(`${model}|${voice}|${speed}|${text}`).digest("hex").slice(0, 32)}`;
}

/**
 * HeyGen Voice Turbo on OpenRouter returns raw signed 16-bit little-endian PCM,
 * not MP3, and rejects `response_format: "mp3"`. Wrap the PCM in a WAV header
 * so the browser can decode it without adding a system transcoder dependency.
 */
function pcmToWav(pcm: Buffer, sampleRate = 44_100, channels = 1, bitsPerSample = 16): Buffer {
  const data = pcm.length % 2 === 0 ? pcm : pcm.subarray(0, pcm.length - 1);
  const header = Buffer.alloc(44);
  const blockAlign = channels * (bitsPerSample / 8);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function pcmParameters(contentType: string): { sampleRate: number; channels: number } {
  const sampleRate = Number(/rate=(\d+)/i.exec(contentType)?.[1] ?? 44_100);
  const channels = Number(/channels=(\d+)/i.exec(contentType)?.[1] ?? 1);
  return {
    sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44_100,
    channels: Number.isFinite(channels) && channels > 0 ? channels : 1,
  };
}

export type SpeechSynthesisResult = {
  bytes: Buffer;
  mime: string;
  cached: boolean;
  voice: string;
  source: "openrouter-heygen" | "freellmapi" | "cache";
  model: string;
  expiresAt: string | null;
  generationId: string | null;
};

/** Preserve the existing FreeLLMAPI speech implementation for explicit callers. */
export async function synthesizeFreeLlmSpeech(
  input: string,
  options: { voice?: string; speed?: number } = {},
): Promise<SpeechSynthesisResult> {
  const config = voiceConfig();
  if (!config.configured) throw new VoiceUnavailableError("unconfigured", config.issues.join(" "));
  const text = speechFriendly(input);
  if (!text) throw new VoiceUnavailableError("empty", "There is nothing to speak.");
  const voice = (options.voice ?? config.voice).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || config.voice;
  const speed = Math.min(1.3, Math.max(0.7, Number(options.speed ?? 1) || 1));
  const cacheId = ttsCacheId(text, voice, speed, config.ttsModel);

  const cached = findTempObject(cacheId);
  if (cached?.relative_path) {
    try {
      const bytes = await readFile(tempFilePath(cached.relative_path));
      if (bytes.length > 1000) {
        return {
          bytes,
          mime: "audio/wav",
          cached: true,
          voice,
          source: "cache",
          model: config.ttsModel,
          expiresAt: null,
          generationId: null,
        };
      }
    } catch {
      // Cache file vanished: regenerate below.
    }
  }

  const decision = authorizeAiRequest({
    provider: "freellmapi",
    model: config.ttsModel,
    agentKey: "coordinator",
    operation: "voice.tts",
    source: "assistant",
  });
  if (!decision.allowed) {
    throw new VoiceUnavailableError("provider", decision.block_reason ?? "The server-side speech provider is not authorised.");
  }

  let response: Response;
  try {
    markPolicyNetworkTransmitted(decision.correlation_id);
    response = await fetch(`${config.baseUrl}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.FREELLMAPI_API_KEY ?? ""}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ttsModel,
        voice,
        input: text,
        response_format: "wav",
        speed,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new VoiceUnavailableError("provider", `Speech gateway unreachable: ${scrubProviderError(error instanceof Error ? error.message : "network error")}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new VoiceUnavailableError("provider", `Speech gateway returned ${response.status}. ${scrubProviderError(body).slice(0, 200)}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1000) throw new VoiceUnavailableError("provider", "The speech gateway returned an empty audio stream.");

  const fileName = `${cacheId}.wav`;
  try {
    await mkdir(TEMP_DIR, { recursive: true });
    await writeFile(tempFilePath(fileName), bytes);
    registerTempObject({
      id: cacheId,
      kind: "tts_audio",
      fileName,
      sizeBytes: bytes.length,
      ttlHours: ttlHours(),
      meta: { model: config.ttsModel, voice, speed },
    });
  } catch {
    // Serving the audio still works even if the cache could not be written.
  }
  return {
    bytes,
    mime: "audio/wav",
    cached: false,
    voice,
    source: "freellmapi",
    model: config.ttsModel,
    expiresAt: null,
    generationId: null,
  };
}

/**
 * Dedicated OpenRouter HeyGen Voice Turbo free speech adapter.
 *
 * The exact `:free` model, its zero price and its retirement date are verified
 * against OpenRouter's catalogue before the POST. The request is restricted to
 * the `heygen` provider with fallbacks disabled. The paid counterpart is never
 * requested if the free model is unavailable or retired.
 */
export async function synthesizeOpenRouterSpeech(
  input: string,
  options: { voice?: string } = {},
): Promise<SpeechSynthesisResult> {
  const config = openRouterTtsConfig();
  const issue = openRouterTtsPolicyIssue();
  if (issue) throw new VoiceUnavailableError("unconfigured", issue);
  const text = speechFriendly(input);
  if (!text) throw new VoiceUnavailableError("empty", "There is nothing to speak.");

  const requestedVoice = (options.voice ?? config.voice).trim();
  const voice = (OPENROUTER_HEYGEN_VOICES as readonly string[]).includes(requestedVoice)
    ? requestedVoice
    : config.voice;
  const cacheId = ttsCacheId(text, voice, 1, config.model);
  const cached = findTempObject(cacheId);
  if (cached?.relative_path) {
    try {
      const bytes = await readFile(tempFilePath(cached.relative_path));
      if (bytes.length > 1000) {            return {
              bytes,
              mime: "audio/wav",
              cached: true,
              voice,
              source: "cache",
              model: config.model,
              expiresAt: config.expiresAt,
              generationId: null,
            };
      }
    } catch {
      // Cache file vanished: regenerate below.
    }
  }

  const validation = await validateOpenRouterFreeModel(config.model, "speech");
  if (!validation.ok) throw new VoiceUnavailableError("provider", validation.reason);

  const decision = authorizeAiRequest({
    provider: "openrouter",
    model: config.model,
    agentKey: "coordinator",
    operation: "voice.tts",
    source: "assistant",
  });
  if (!decision.allowed) {
    throw new VoiceUnavailableError("provider", decision.block_reason ?? "The OpenRouter speech route is not authorised.");
  }

  let response: Response;
  try {
    markPolicyNetworkTransmitted(decision.correlation_id);
    response = await fetch(`${config.baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
        "X-Title": "AT AI Workforce",
        ...(process.env.APP_BASE_URL?.trim() ? { "HTTP-Referer": process.env.APP_BASE_URL.trim() } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        input: text,
        voice,
        response_format: "pcm",
        provider: {
          only: [config.provider],
          order: [config.provider],
          allow_fallbacks: false,
        },
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new VoiceUnavailableError(
      "provider",
      `OpenRouter HeyGen speech was unreachable: ${scrubProviderError(error instanceof Error ? error.message : "network error")}`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new VoiceUnavailableError(
      "provider",
      `OpenRouter HeyGen speech returned ${response.status}. ${scrubProviderError(body).slice(0, 220)}`,
    );
  }
  const mimeHeader = response.headers.get("content-type") ?? "";
  if (!mimeHeader.startsWith("audio/")) {
    throw new VoiceUnavailableError("provider", "OpenRouter returned a non-audio response for speech.");
  }
  const rawBytes = Buffer.from(await response.arrayBuffer());
  if (rawBytes.length < 1000) throw new VoiceUnavailableError("provider", "OpenRouter returned an empty audio stream.");
  const generationId = response.headers.get("x-generation-id");

  let bytes: Buffer;
  let mime: string;
  let extension: string;
  if (mimeHeader.toLowerCase().startsWith("audio/pcm")) {
    const { sampleRate, channels } = pcmParameters(mimeHeader);
    bytes = pcmToWav(rawBytes, sampleRate, channels);
    mime = "audio/wav";
    extension = "wav";
  } else if (mimeHeader.toLowerCase().startsWith("audio/mpeg")) {
    bytes = rawBytes;
    mime = "audio/mpeg";
    extension = "mp3";
  } else if (mimeHeader.toLowerCase().startsWith("audio/wav")) {
    bytes = rawBytes;
    mime = "audio/wav";
    extension = "wav";
  } else {
    throw new VoiceUnavailableError("provider", `OpenRouter returned unsupported speech type ${mimeHeader.slice(0, 80)}.`);
  }

  const fileName = `${cacheId}.${extension}`;
  try {
    await mkdir(TEMP_DIR, { recursive: true });
    await writeFile(tempFilePath(fileName), bytes);
    registerTempObject({
      id: cacheId,
      kind: "tts_audio",
      fileName,
      sizeBytes: bytes.length,
      ttlHours: ttlHours(),
      meta: { model: config.model, voice, provider: config.provider },
    });
  } catch {
    // Serving the audio still works even if the cache could not be written.
  }

  return {
    bytes,
    mime,
    cached: false,
    voice,
    source: "openrouter-heygen",
    model: config.model,
    expiresAt: validation.expiresAt ?? config.expiresAt,
    generationId,
  };
}

/** Chief speech uses OpenRouter HeyGen; explicit FreeLLMAPI callers keep their route. */
export async function synthesizeSpeech(
  input: string,
  options: { voice?: string; speed?: number; provider?: "openrouter" | "freellmapi" } = {},
): Promise<SpeechSynthesisResult> {
  if (options.provider === "freellmapi") return synthesizeFreeLlmSpeech(input, options);
  return synthesizeOpenRouterSpeech(input, options);
}

export async function transcribeAudio(input: {
  bytes: Buffer;
  filename: string;
  mime: string;
}): Promise<{ text: string; model: string }> {
  const config = voiceConfig();
  if (!config.configured) throw new VoiceUnavailableError("unconfigured", config.issues.join(" "));
  const decision = authorizeAiRequest({
    provider: "freellmapi",
    model: config.sttModel,
    agentKey: "coordinator",
    operation: "voice.transcribe",
    source: "assistant",
  });
  if (!decision.allowed) {
    throw new VoiceUnavailableError("provider", decision.block_reason ?? "The transcription provider is not authorised.");
  }
  const form = new FormData();
  const blob = new Blob([Uint8Array.from(input.bytes)], { type: input.mime || "audio/webm" });
  form.append("file", blob, input.filename || "speech.webm");
  form.append("model", config.sttModel);

  let response: Response;
  try {
    markPolicyNetworkTransmitted(decision.correlation_id);
    response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.FREELLMAPI_API_KEY ?? ""}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new VoiceUnavailableError("provider", `Transcription gateway unreachable: ${scrubProviderError(error instanceof Error ? error.message : "network error")}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new VoiceUnavailableError("provider", `Transcription gateway returned ${response.status}. ${scrubProviderError(body).slice(0, 200)}`);
  }
  const payload = (await response.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!text) throw new VoiceUnavailableError("empty", "No speech was recognised in that recording.");
  return { text, model: config.sttModel };
}

/** Public, secret-free capability summary for the UI. */
export function voiceCapabilities() {
  const config = voiceConfig();
  return {
    configured: config.configured,
    blockedByPolicy: config.blockedByPolicy,
    ttsModel: config.ttsModel,
    sttModel: config.sttModel,
    voice: config.voice,
    issues: config.issues,
    voices: ["Charon", "Kore", "Puck", "Fenrir", "Aoede"],
    openRouter: {
      configured: openRouterTtsConfigured(),
      model: openRouterTtsConfig().model,
      voice: openRouterTtsConfig().voice,
      provider: openRouterTtsConfig().provider,
      expiresAt: openRouterTtsConfig().expiresAt,
      policyIssue: openRouterTtsPolicyIssue(),
    },
    note: "Chief speech uses the exact OpenRouter HeyGen free model and falls back to the browser's labelled system voice if it is unavailable. Gemini Live is a separate route.",
  };
}
