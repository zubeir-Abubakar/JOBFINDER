"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AgentAvatar } from "./AgentAvatar";
import { agentIdentity } from "@/lib/agent-identity";

type Msg = { id: string | number; role: string; content: string; created_at?: string };
type VoiceSettings = { voice: string; speed: number; volume: number; muted: boolean; spokenProgress: boolean };

const DEFAULT_SETTINGS: VoiceSettings = { voice: "nadine", speed: 1, volume: 1, muted: false, spokenProgress: true };
const STORAGE_KEY = "atw.voice.settings.v1";
const VOICES = [
  ["nadine", "Nadine — clear, natural default (OpenRouter HeyGen free)"],
  ["tabitha", "Tabitha — warm female voice (OpenRouter HeyGen free)"],
  ["bram", "Bram — lower male voice (OpenRouter HeyGen free)"],
  ["gareth", "Gareth — deliberate male voice (OpenRouter HeyGen free)"],
  ["noelle", "Noelle — composed female voice (OpenRouter HeyGen free)"],
  ["meredith", "Meredith — measured female voice (OpenRouter HeyGen free)"],
  ["sabrina", "Sabrina — brighter female voice (OpenRouter HeyGen free)"],
  ["lucian", "Lucian — lower male voice (OpenRouter HeyGen free)"],
  ["weston", "Weston — steady male voice (OpenRouter HeyGen free)"],
  ["vincent", "Vincent — deep male voice (OpenRouter HeyGen free)"],
];
const EVENT_TYPES = [
  "workflow.started",
  "workflow.completed",
  "workflow.paused",
  "workflow.failed",
  "workflow.cancelled",
  "agent.queued",
  "agent.started",
  "agent.progress",
  "agent.completed",
  "agent.failed",
  "agent.retrying",
  "approval.required",
  "approval.granted",
];
const ANNOUNCE = new Set(["agent.completed", "agent.failed", "workflow.paused", "workflow.completed", "workflow.failed", "approval.required"]);

function loadSettings(): VoiceSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<VoiceSettings>;
    const savedVoice = typeof parsed.voice === "string" ? parsed.voice : "";
    return {
      voice: VOICES.some(([id]) => id === savedVoice) ? savedVoice : DEFAULT_SETTINGS.voice,
      speed: Math.min(1.3, Math.max(0.7, Number(parsed.speed ?? 1) || 1)),
      volume: Math.min(1, Math.max(0, Number(parsed.volume ?? 1))),
      muted: Boolean(parsed.muted),
      spokenProgress: parsed.spokenProgress !== false,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function VoiceAssistant({
  initialMessages,
  hideTrigger = false,
  defaultOpen = false,
  onClose,
}: {
  initialMessages: Msg[];
  hideTrigger?: boolean;
  defaultOpen?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"voice" | "text">("voice");
  const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_SETTINGS);
  const [listening, setListening] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [notice, setNotice] = useState("");
  const [progressLine, setProgressLine] = useState("");

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const seenEvents = useRef<Set<number>>(new Set());
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAnnouncement = useRef<string>("");
  const speakingRef = useRef(false);
  const processingRef = useRef(false);
  const settingsRef = useRef(settings);

  useEffect(() => setSettings(loadSettings()), []);
  useEffect(() => {
    settingsRef.current = settings;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Private mode: settings simply stay in memory.
    }
  }, [settings]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, processing]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const stopSpeaking = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    speakingRef.current = false;
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    async (text: string) => {
      const current = settingsRef.current;
      if (!text.trim() || current.muted) return;
      stopSpeaking();
      speakingRef.current = true;
      setSpeaking(true);
      setNotice("");
      try {
        const response = await fetch("/api/voice/speech", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voice: current.voice, speed: current.speed }),
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? "Gateway speech unavailable.");
        }
        const blob = await response.blob();
        if (blob.size < 1000) throw new Error("Gateway returned an empty voice stream.");
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.volume = current.volume;
        audioRef.current = audio;
        objectUrlRef.current = url;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          objectUrlRef.current = null;
          audioRef.current = null;
          speakingRef.current = false;
          setSpeaking(false);
        };
        await audio.play();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Gateway speech unavailable.";
        // Honest fallback: the browser's own system voice, clearly labelled.
        if (typeof window !== "undefined" && "speechSynthesis" in window) {
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.rate = current.speed;
          utterance.volume = current.volume;
          const voices = window.speechSynthesis.getVoices();
          utterance.voice =
            voices.find((voice) => /en[-_](ZA|KE|NG|GH)/i.test(voice.lang)) ??
            voices.find((voice) => /en[-_]GB/i.test(voice.lang)) ??
            voices[0] ??
            null;
          utterance.onend = () => {
            speakingRef.current = false;
            setSpeaking(false);
          };
          window.speechSynthesis.speak(utterance);
          setNotice(`${message} Using the browser system voice instead — its accent and quality are not controlled by the app.`);
        } else {
          speakingRef.current = false;
          setSpeaking(false);
          setNotice(message);
        }
      }
    },
    [stopSpeaking],
  );

  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim().slice(0, 2000);
      if (!message || processingRef.current) return;
      setInput("");
      setNotice("");
      setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: "user", content: message }]);
      processingRef.current = true;
      setProcessing(true);
      try {
        const response = await fetch("/api/assistant/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        });
        const payload = (await response.json().catch(() => ({}))) as { reply?: string; error?: string };
        if (!response.ok || !payload.reply) throw new Error(payload.error ?? "The Coordinator could not answer.");
        setMessages((prev) => [...prev, { id: `local-a-${Date.now()}`, role: "assistant", content: payload.reply as string }]);
        void speak(payload.reply as string);
      } catch (error) {
        const reply = error instanceof Error ? error.message : "The Coordinator is unavailable right now.";
        setNotice(reply);
        setMessages((prev) => [...prev, { id: `local-e-${Date.now()}`, role: "assistant", content: reply }]);
      } finally {
        processingRef.current = false;
        setProcessing(false);
      }
    },
    [speak],
  );

  const stopListening = useCallback(() => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    stopTimerRef.current = null;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setListening(false);
  }, []);

  const startListening = useCallback(async () => {
    if (listening) {
      stopListening();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setNotice("Microphone recording is not supported in this browser. Type your instruction instead.");
      setMode("text");
      return;
    }
    stopSpeaking();
    setNotice("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        void (async () => {
          if (blob.size < 900) {
            setNotice("That recording was too short. Hold the microphone and speak, then press stop.");
            return;
          }
          setProcessing(true);
          processingRef.current = true;
          try {
            const form = new FormData();
            form.append("file", blob, "speech.webm");
            const response = await fetch("/api/voice/transcribe", { method: "POST", body: form });
            const payload = (await response.json().catch(() => ({}))) as { text?: string; error?: string };
            if (!response.ok || !payload.text) throw new Error(payload.error ?? "Speech recognition is unavailable.");
            setInput(payload.text);
            await send(payload.text);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Speech recognition is unavailable.";
            setNotice(`${message} You can type the instruction instead.`);
          } finally {
            processingRef.current = false;
            setProcessing(false);
          }
        })();
      };
      recorder.start();
      recorderRef.current = recorder;
      setListening(true);
      stopTimerRef.current = setTimeout(() => stopListening(), 25_000);
    } catch {
      setNotice("Microphone permission was denied. Allow it in the browser or type instead.");
      setListening(false);
    }
  }, [listening, send, stopListening, stopSpeaking]);

  useEffect(() => {
    return () => {
      stopListening();
      stopSpeaking();
      if (announceTimer.current) clearTimeout(announceTimer.current);
    };
  }, [stopListening, stopSpeaking]);

  const announce = useCallback(
    (text: string) => {
      pendingAnnouncement.current = text;
      if (announceTimer.current) clearTimeout(announceTimer.current);
      announceTimer.current = setTimeout(() => {
        const line = pendingAnnouncement.current;
        pendingAnnouncement.current = "";
        if (!line || speakingRef.current || processingRef.current) return;
        setProgressLine(line);
        void speak(line);
      }, 1200);
    },
    [speak],
  );

  // Spoken progress comes only from persisted backend events, never from a timer.
  useEffect(() => {
    if (!settings.spokenProgress) return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = async () => {
      if (disposed) return;
      const snapshot = await fetch("/api/workflows/latest", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
      const workflowId = (snapshot as { workflow?: { id?: string } } | null)?.workflow?.id;
      if (!workflowId) {
        retry = setTimeout(connect, 60_000);
        return;
      }
      source = new EventSource(`/api/workflows/${workflowId}/events`);
      const handler = (raw: MessageEvent) => {
        try {
          const event = JSON.parse(raw.data) as { id: number; type: string; message: string | null; created_at: string };
          if (seenEvents.current.has(event.id)) return;
          seenEvents.current.add(event.id);
          if (seenEvents.current.size > 400) seenEvents.current = new Set(Array.from(seenEvents.current).slice(-200));
          if (!ANNOUNCE.has(event.type) || !event.message) return;
          if (Date.now() - new Date(event.created_at).getTime() > 120_000) return;
          const name = event.type.split(".")[0] === "workflow" ? "Coordinator" : "An agent";
          announce(event.type === "approval.required" ? event.message : `${name}: ${event.message}`);
        } catch {
          // Ignore malformed frames.
        }
      };
      for (const type of EVENT_TYPES) source.addEventListener(type, handler as EventListener);
      source.onerror = () => {
        // EventSource retries by itself; no polling loop is started here.
      };
    };
    void connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [settings.spokenProgress, announce]);

  const micLabel = listening ? "Stop recording" : "Speak to the Coordinator";

  return (
    <>
      {hideTrigger ? null : (
        <button
          type="button"
          className={`header-cta voice-trigger ${open ? "active" : ""}`}
          aria-label="Open the AI voice assistant"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <AgentAvatar agentKey="coordinator" status={listening ? "working" : speaking ? "thinking" : "idle"} size={26} />
          <span className="header-cta-label">Ask AI</span>
          <span className="voice-trigger-dot" data-live={listening || speaking || processing} />
        </button>
      )}

      {open ? (
        <div className="voice-panel" role="dialog" aria-label="AI voice assistant">
          <div className="voice-head">
            <div className="flex items-center gap-2.5 min-w-0">
              <AgentAvatar agentKey="coordinator" status={listening ? "working" : speaking ? "thinking" : "idle"} size={38} />
              <div className="min-w-0">
                <div className="text-[13.5px] font-semibold truncate">{agentIdentity("coordinator").name}</div>
                <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                  {listening ? "Listening — speak, then press stop" : processing ? "Coordinating your request…" : speaking ? "Speaking — press interrupt to stop" : "Voice and text · approval rules unchanged"}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button type="button" className="btn btn-sm" onClick={() => setSettingsOpen((value) => !value)} aria-expanded={settingsOpen}>
                Voice
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label="Close assistant"
                onClick={() => {
                  setOpen(false);
                  onClose?.();
                }}
              >
                ✕
              </button>
            </div>
          </div>

          {settingsOpen ? (
            <div className="voice-settings">
              <div>
                <label className="label" htmlFor="voice-name">Voice</label>
                <select
                  id="voice-name"
                  className="select"
                  value={settings.voice}
                  onChange={(event) => setSettings((prev) => ({ ...prev, voice: event.target.value }))}
                >
                  {VOICES.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="voice-speed">Speed · {settings.speed.toFixed(2)}×</label>
                  <input
                    id="voice-speed"
                    type="range"
                    min={0.7}
                    max={1.3}
                    step={0.05}
                    value={settings.speed}
                    onChange={(event) => setSettings((prev) => ({ ...prev, speed: Number(event.target.value) }))}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="voice-volume">Volume · {Math.round(settings.volume * 100)}%</label>
                  <input
                    id="voice-volume"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.volume}
                    onChange={(event) => setSettings((prev) => ({ ...prev, volume: Number(event.target.value) }))}
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-[12px]">
                <input type="checkbox" checked={settings.muted} onChange={(event) => setSettings((prev) => ({ ...prev, muted: event.target.checked }))} />
                Mute spoken replies
              </label>
              <label className="flex items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={settings.spokenProgress}
                  onChange={(event) => setSettings((prev) => ({ ...prev, spokenProgress: event.target.checked }))}
                />
                Announce agent progress aloud
              </label>
              <div className="flex items-center gap-2">
                <button type="button" className="btn btn-sm" onClick={() => void speak("Good afternoon. Your CV specialist has finished the first draft, and it is now undergoing ATS quality checks.")}>
                  Test voice
                </button>
                <span className="text-[10.5px]" style={{ color: "var(--muted)" }}>
                  Charon is a calm male gateway voice; an explicit East African accent is not available, and none is faked.
                </span>
              </div>
            </div>
          ) : null}

          <div className="voice-log" ref={scrollRef}>
            {messages.length === 0 ? (
              <div className="voice-empty">
                <p className="text-[12.5px] font-medium">Speak naturally. I only act from real records.</p>
                <p className="text-[11.5px] mt-1" style={{ color: "var(--muted)" }}>
                  “Find me new Senior QA Engineer jobs.” “Show me what the agents are doing.” “Explain why this job scored low.” Sending applications and emails still needs your explicit approval.
                </p>
              </div>
            ) : (
              messages.map((message) => (
                <div key={message.id} className={`voice-msg ${message.role === "user" ? "voice-msg-user" : "voice-msg-bot"}`}>
                  <div className="voice-msg-role">{message.role === "user" ? "You" : "Coordinator"}</div>
                  <div className="voice-msg-text">{message.content}</div>
                </div>
              ))
            )}
            {processing ? <div className="voice-thinking"><span className="dot" /> Coordinating…</div> : null}
            {progressLine && settings.spokenProgress ? <div className="voice-progress">🔊 {progressLine}</div> : null}
          </div>

          {notice ? <div className="voice-notice">{notice}</div> : null}

          <div className="voice-controls">
            <div className="voice-mode">
              <button type="button" className={`voice-mode-btn ${mode === "voice" ? "active" : ""}`} onClick={() => setMode("voice")}>Voice</button>
              <button type="button" className={`voice-mode-btn ${mode === "text" ? "active" : ""}`} onClick={() => setMode("text")}>Text</button>
            </div>
            <form
              className="voice-form"
              onSubmit={(event) => {
                event.preventDefault();
                void send(input);
              }}
            >
              <input
                className="input"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={mode === "voice" ? "Speak, or type an instruction…" : "Type an instruction…"}
                disabled={processing}
                aria-label={`Message ${agentIdentity("coordinator").name}`}
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={processing || !input.trim()}>
                Send
              </button>
            </form>
            <div className="voice-actions">
              <button
                type="button"
                className={`btn btn-sm ${listening ? "btn-danger" : ""}`}
                onClick={() => void startListening()}
                disabled={processing}
                aria-pressed={listening}
                aria-label={micLabel}
              >
                {listening ? "■ Stop" : "🎙 Speak"}
              </button>
              {speaking ? (
                <button type="button" className="btn btn-sm" onClick={stopSpeaking}>
                  Interrupt
                </button>
              ) : (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSettings((prev) => ({ ...prev, muted: !prev.muted }))} aria-pressed={settings.muted}>
                  {settings.muted ? "Unmute" : "Mute"}
                </button>
              )}
              <Link href="/assistant" className="btn btn-sm btn-ghost">Full conversation</Link>
            </div>
            <p className="voice-hint">
              Microphone starts only when you press Speak and stops when you press Stop (or after 25 seconds). Audio is sent to your local FreeLLMAPI gateway for transcription; only a short-lived TTS cache is stored locally.
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}
