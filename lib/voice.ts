import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { TEMP_DIR } from "./db";
import { scrubProviderError } from "./providers";
import { findTempObject, registerTempObject, tempFilePath, ttlHours } from "./temp-store";

/**
 * Voice adapter for the FreeLLMAPI gateway. The API key stays on the server:
 * transcriptions and speech are proxied through authenticated route handlers.
 * Verified against the local gateway on 2026-11-18 with
 * gemini-2.5-flash-preview-tts (voice Charon, WAV) and whisper-1 transcription.
 */

export type VoiceConfig = {
  configured: boolean;
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

export async function synthesizeSpeech(
  input: string,
  options: { voice?: string; speed?: number } = {},
): Promise<{ bytes: Buffer; mime: string; cached: boolean; voice: string }> {
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
      if (bytes.length > 1000) return { bytes, mime: "audio/wav", cached: true, voice };
    } catch {
      // Cache file vanished: regenerate below.
    }
  }

  let response: Response;
  try {
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
  return { bytes, mime: "audio/wav", cached: false, voice };
}

export async function transcribeAudio(input: {
  bytes: Buffer;
  filename: string;
  mime: string;
}): Promise<{ text: string; model: string }> {
  const config = voiceConfig();
  if (!config.configured) throw new VoiceUnavailableError("unconfigured", config.issues.join(" "));
  const form = new FormData();
  const blob = new Blob([Uint8Array.from(input.bytes)], { type: input.mime || "audio/webm" });
  form.append("file", blob, input.filename || "speech.webm");
  form.append("model", config.sttModel);

  let response: Response;
  try {
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
    ttsModel: config.ttsModel,
    sttModel: config.sttModel,
    voice: config.voice,
    issues: config.issues,
    voices: ["Charon", "Kore", "Puck", "Fenrir", "Aoede"],
    note: "Voice is generated by the local FreeLLMAPI gateway. If it is unavailable the browser's system voice is used and labelled as such.",
  };
}
