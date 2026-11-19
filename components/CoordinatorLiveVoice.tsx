"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { OrbLevels, OrbState } from "./CosmicOrb";
import { VoiceAssistant } from "./VoiceAssistant";
import { agentDefinition } from "@/lib/agent-definitions";
import { voiceProfileForAgent, type LiveVoiceId } from "@/lib/agent-voices";

const CosmicOrb = dynamic(() => import("./CosmicOrb"), {
  ssr: false,
  loading: () => <div className="lv-orb-loading" aria-hidden="true" />,
});

type Msg = { id: string | number; role: string; content: string; created_at?: string; agentKey?: AgentKey };
type LiveState = "idle" | "connecting" | "listening" | "processing" | "speaking" | "interrupted" | "disconnected" | "error";
type AgentKey = "coordinator" | "research" | "analysis" | "cv" | "ats" | "cover" | "application" | "email";
type VoiceName = LiveVoiceId;

type LiveSetup = {
  model: string;
  generationConfig: {
    responseModalities: string[];
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
  };
  systemInstruction: { parts: Array<{ text: string }> };
  tools: unknown[];
  inputAudioTranscription: Record<string, never>;
  outputAudioTranscription: Record<string, never>;
  realtimeInputConfig: {
    automaticActivityDetection: { disabled: boolean };
    activityHandling: string;
  };
  sessionResumption: Record<string, never>;
};

type SessionPayload = {
  wsUrl: string;
  setup: LiveSetup;
  tokenExpiresAt: string;
  sessionExpiresAt: string;
  agentKey: AgentKey;
  agentName: string;
  sessionId: string;
  model: string;
  voice: VoiceName;
  voiceName?: string;
  greeting: boolean;
};

type ToolCall = { id?: string; name?: string; args?: Record<string, unknown> };

const AGENT_LABELS: Record<AgentKey, string> = {
  coordinator: "Chief Coordinator",
  research: "Job Research",
  analysis: "Job Analysis",
  cv: "CV Optimisation",
  ats: "ATS Quality Control",
  cover: "Cover Letter",
  application: "Application",
  email: "Email & Tracking",
};

const STATUS: Record<LiveState, { label: string; hint: string; tone: string }> = {
  idle: { label: "Ready", hint: "Start a live voice conversation.", tone: "neutral" },
  connecting: { label: "Connecting", hint: "Requesting microphone and Live session…", tone: "info" },
  listening: { label: "Listening", hint: "Speak naturally. Pause when you are finished.", tone: "good" },
  processing: { label: "Thinking", hint: "Coordinating your request…", tone: "info" },
  speaking: { label: "Speaking", hint: "Speak at any time to interrupt.", tone: "good" },
  interrupted: { label: "Interrupted", hint: "Playback cleared. Listening again.", tone: "warn" },
  disconnected: { label: "Disconnected", hint: "The live session has ended.", tone: "neutral" },
  error: { label: "Unavailable", hint: "Live voice could not start.", tone: "bad" },
};

const SESSION_KEY = "atw.live.session.v1";

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}${crypto.randomUUID().replace(/-/g, "")}`;
  return `${prefix}${Date.now()}${Math.random().toString(36).slice(2)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const size = 0x8000;
  for (let index = 0; index < bytes.length; index += size) {
    binary += String.fromCharCode(...bytes.subarray(index, index + size));
  }
  return btoa(binary);
}

function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

export function CoordinatorLiveVoice({ initialMessages }: { initialMessages: Msg[] }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LiveState>("idle");
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [partialUser, setPartialUser] = useState("");
  const [partialAssistant, setPartialAssistant] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [model, setModel] = useState("Gemini Live");
  const [muted, setMuted] = useState(false);
  const [activeAgent, setActiveAgent] = useState<AgentKey>("coordinator");
  const [usage, setUsage] = useState<{ prompt: number; response: number; total: number } | null>(null);
  const usageRef = useRef<{ prompt: number; response: number; total: number } | null>(null);
  const reportedUsage = useRef({ prompt: 0, response: 0, total: 0 });
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [compactOrb, setCompactOrb] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const wsGeneration = useRef(0);
  const intentionalClose = useRef(false);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handoffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionIdRef = useRef("");
  const activeAgentRef = useRef<AgentKey>("coordinator");
  const stateRef = useRef<LiveState>("idle");
  const greetingRef = useRef(false);
  const resumptionHandle = useRef("");
  const pendingHandoff = useRef<AgentKey | null>(null);
  const switching = useRef(false);

  const inputTranscript = useRef("");
  const outputTranscript = useRef("");
  const turnTaskIds = useRef<string[]>([]);
  const turnId = useRef(makeId("turn-"));
  const interrupted = useRef(false);
  const ignoreAudio = useRef(false);
  const manualInterrupt = useRef(false);
  const interruptQuietSince = useRef(0);
  const interruptReadyForUser = useRef(false);
  const bargeFrames = useRef(0);

  const micStream = useRef<MediaStream | null>(null);
  const micContext = useRef<AudioContext | null>(null);
  const micNode = useRef<AudioWorkletNode | null>(null);
  const micSource = useRef<MediaStreamAudioSourceNode | null>(null);
  const micMuted = useRef(false);
  const micLevel = useRef(0);
  const micStarting = useRef(false);
  const starting = useRef(false);

  const playbackContext = useRef<AudioContext | null>(null);
  const playbackAnalyser = useRef<AnalyserNode | null>(null);
  const playbackSources = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextPlaybackAt = useRef(0);
  const playbackDrainTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heroRef = useRef<HTMLDivElement | null>(null);
  const orbLevels = useRef<OrbLevels>({ input: 0, output: 0 });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    activeAgentRef.current = activeAgent;
  }, [activeAgent]);

  useEffect(() => {
    try {
      const savedSession = window.sessionStorage.getItem(SESSION_KEY);
      if (savedSession && /^voice_[A-Za-z0-9_-]{6,80}$/.test(savedSession)) sessionIdRef.current = savedSession;
    } catch {
      // Private mode: the session still works without persistence.
    }
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px)");
    const apply = () => setCompactOrb(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, partialUser, partialAssistant, state]);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const tick = () => {
      const input = Math.min(1, micLevel.current * 6.5);
      let output = 0;
      if (stateRef.current === "speaking") {
        const analyser = playbackAnalyser.current;
        if (analyser) {
          const data = new Uint8Array(analyser.fftSize);
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let index = 0; index < data.length; index += 1) {
            const value = (data[index] - 128) / 128;
            sum += value * value;
          }
          const rms = Math.sqrt(sum / data.length);
          output = Math.min(1, Math.max(0, (rms - 0.008) * 10.5));
        }
      }

      if (manualInterrupt.current && interrupted.current) {
        const now = performance.now();
        if (input < 0.02) {
          if (!interruptQuietSince.current) interruptQuietSince.current = now;
          else if (!interruptReadyForUser.current && now - interruptQuietSince.current > 320) {
            interruptReadyForUser.current = true;
          }
        } else if (interruptReadyForUser.current) {
          // A fresh utterance after the interruption re-arms playback. Remaining
          // audio from the interrupted turn is discarded, not replayed.
          manualInterrupt.current = false;
          interrupted.current = false;
          ignoreAudio.current = false;
          interruptReadyForUser.current = false;
          interruptQuietSince.current = 0;
        } else {
          interruptQuietSince.current = 0;
        }
      }

      const playbackLevel = stateRef.current === "speaking" && !ignoreAudio.current ? output : 0;
      const waveLevel = stateRef.current === "speaking" ? playbackLevel : stateRef.current === "listening" ? input : 0;
      orbLevels.current.input = input;
      orbLevels.current.output = playbackLevel;

      const hero = heroRef.current;
      hero?.style.setProperty("--lv-level", Math.max(input, playbackLevel).toFixed(3));
      hero?.style.setProperty("--lv-input", input.toFixed(3));
      hero?.style.setProperty("--lv-output", playbackLevel.toFixed(3));
      hero?.style.setProperty("--lv-wave", waveLevel.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open]);

  function appendMessage(role: "user" | "assistant", content: string) {
    if (!content.trim()) return;
    setMessages((previous) => [...previous, { id: makeId("live-msg-"), role, content: content.trim(), agentKey: activeAgentRef.current }]);
  }

  function stopPlayback() {
    orbLevels.current.output = 0;
    heroRef.current?.style.setProperty("--lv-output", "0");
    heroRef.current?.style.setProperty("--lv-wave", "0");
    if (playbackDrainTimer.current) {
      clearTimeout(playbackDrainTimer.current);
      playbackDrainTimer.current = null;
    }
    for (const source of playbackSources.current) {
      try {
        source.stop();
      } catch {
        // Already ended.
      }
    }
    playbackSources.current.clear();
    nextPlaybackAt.current = 0;
  }

  function ensurePlayback() {
    if (playbackContext.current) {
      void playbackContext.current.resume();
      return playbackContext.current;
    }
    const context = new AudioContext({ latencyHint: "interactive" });
    const gain = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    gain.gain.value = 0.92;
    gain.connect(analyser);
    analyser.connect(context.destination);
    playbackContext.current = context;
    playbackAnalyser.current = analyser;
    void context.resume();
    return context;
  }

  function playPcm(base64: string) {
    if (ignoreAudio.current) return;
    const pcm = base64ToInt16(base64);
    if (pcm.length === 0) return;
    const context = ensurePlayback();
    const audio = context.createBuffer(1, pcm.length, 24000);
    const channel = audio.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) channel[index] = pcm[index] / 32768;
    const source = context.createBufferSource();
    source.buffer = audio;
    if (playbackAnalyser.current) source.connect(playbackAnalyser.current);
    const startAt = Math.max(context.currentTime + 0.035, nextPlaybackAt.current);
    source.start(startAt);
    nextPlaybackAt.current = startAt + audio.duration;
    playbackSources.current.add(source);
    source.onended = () => playbackSources.current.delete(source);
    setState((previous) => (previous === "speaking" ? previous : "speaking"));
  }

  async function stopMicrophone() {
    micStarting.current = false;
    micNode.current?.port.close();
    micNode.current?.disconnect();
    micNode.current = null;
    micSource.current?.disconnect();
    micSource.current = null;
    micStream.current?.getTracks().forEach((track) => track.stop());
    micStream.current = null;
    const context = micContext.current;
    micContext.current = null;
    if (context && context.state !== "closed") await context.close().catch(() => undefined);
    micLevel.current = 0;
    orbLevels.current.input = 0;
    heroRef.current?.style.setProperty("--lv-input", "0");
  }

  async function ensureMicrophone(): Promise<boolean> {
    if (micStream.current && micNode.current) return true;
    if (micStarting.current) return false;
    micStarting.current = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
        throw new Error("This browser does not support continuous microphone streaming.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const context = new AudioContext({ latencyHint: "interactive" });
      await context.resume();
      await context.audioWorklet.addModule("/gemini-pcm-worklet.js");
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, "gemini-pcm-processor");
      // A silent sink keeps the worklet graph alive without routing the mic to the speakers.
      const sink = context.createGain();
      sink.gain.value = 0;
      node.connect(sink);
      sink.connect(context.destination);
      node.port.onmessage = (event: MessageEvent<{ type?: string; buffer?: ArrayBuffer; level?: number }>) => {
        const data = event.data;
        if (data?.type !== "audio" || !(data.buffer instanceof ArrayBuffer)) return;
        micLevel.current = Math.max(0, Math.min(1, Number(data.level ?? 0)));
        if (stateRef.current === "speaking") {
          if (micLevel.current > 0.075) bargeFrames.current += 1;
          else bargeFrames.current = 0;
          if (bargeFrames.current >= 3) {
            bargeFrames.current = 0;
            ignoreAudio.current = true;
            interrupted.current = true;
            stopPlayback();
            setState("interrupted");
          }
        } else {
          bargeFrames.current = 0;
        }
        const ws = wsRef.current;
        if (!micMuted.current && ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              realtimeInput: {
                audio: { data: bytesToBase64(new Uint8Array(data.buffer)), mimeType: "audio/pcm;rate=16000" },
              },
            }),
          );
        }
      };
      source.connect(node);
      micStream.current = stream;
      micContext.current = context;
      micSource.current = source;
      micNode.current = node;
      const track = stream.getAudioTracks()[0];
      if (track) track.enabled = !micMuted.current;
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Microphone access was denied.");
      setState("error");
      await stopMicrophone();
      return false;
    } finally {
      micStarting.current = false;
    }
  }

  async function saveTurn(
    role: "user" | "assistant",
    content: string,
    interruptedTurn: boolean,
    tokenDelta?: { promptTokens: number; completionTokens: number; totalTokens: number },
  ) {
    if (!content.trim() || !sessionIdRef.current) return;
    try {
      await fetch("/api/voice/live/transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          turnId: turnId.current,
          role,
          content: content.trim(),
          agentKey: activeAgentRef.current,
          taskIds: turnTaskIds.current,
          interrupted: interruptedTurn,
          model,
          usage: tokenDelta,
        }),
      });
    } catch {
      // A transcript write must never break the live conversation.
    }
  }

  function consumeUsageDelta(): { promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
    const current = usageRef.current;
    if (!current) return undefined;
    const delta = {
      promptTokens: Math.max(0, current.prompt - reportedUsage.current.prompt),
      completionTokens: Math.max(0, current.response - reportedUsage.current.response),
      totalTokens: Math.max(0, current.total - reportedUsage.current.total),
    };
    reportedUsage.current = { prompt: current.prompt, response: current.response, total: current.total };
    return delta.totalTokens > 0 ? delta : undefined;
  }

  function flushTranscripts() {
    const userText = inputTranscript.current.trim();
    const assistantText = outputTranscript.current.trim();
    const wasInterrupted = interrupted.current;
    if (userText) {
      appendMessage("user", userText);
      void saveTurn("user", userText, wasInterrupted);
    }
    if (assistantText) {
      const tokenDelta = consumeUsageDelta();
      appendMessage("assistant", assistantText);
      void saveTurn("assistant", assistantText, wasInterrupted, tokenDelta);
    }
    inputTranscript.current = "";
    outputTranscript.current = "";
    turnTaskIds.current = [];
    turnId.current = makeId("turn-");
    setPartialUser("");
    setPartialAssistant("");
    interrupted.current = false;
  }

  async function performHandoff(target: AgentKey) {
    if (switching.current) return;
    switching.current = true;
    pendingHandoff.current = null;
    if (handoffTimer.current) {
      clearTimeout(handoffTimer.current);
      handoffTimer.current = null;
    }
    // Cut the old agent's speech immediately. The handoff must not wait for
    // queued audio, a model turn or a timer before the identity changes.
    stopPlayback();
    setNotice(`Switching to ${AGENT_LABELS[target]}…`);
    flushTranscripts();
    setActiveAgent(target);
    activeAgentRef.current = target;
    setState("connecting");
    await startLive(target, { greet: true, fresh: false, preserveMessages: true });
    switching.current = false;
  }

  async function runTool(calls: ToolCall[]) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const responses: Array<{ id?: string; name?: string; response: Record<string, unknown> }> = [];
    if (calls.length > 0) setState("processing");
    for (const call of calls) {
      if (!call.name) continue;
      try {
        const response = await fetch("/api/voice/live/tool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: call.name,
            args: call.args ?? {},
            agentKey: activeAgentRef.current,
            sessionId: sessionIdRef.current,
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          response?: Record<string, unknown>;
          handoff?: { agentKey?: AgentKey };
          error?: string;
        };
        responses.push({
          id: call.id,
          name: call.name,
          response: payload.response ?? { ok: false, error: payload.error ?? "The workspace tool failed." },
        });
        const ids = payload.response?.taskIds;
        if (Array.isArray(ids)) {
          turnTaskIds.current = ids.filter((id): id is string => typeof id === "string").slice(0, 12);
        }
        if (payload.handoff?.agentKey) {
          pendingHandoff.current = payload.handoff.agentKey;
          if (handoffTimer.current) clearTimeout(handoffTimer.current);
          handoffTimer.current = setTimeout(() => {
            const target = pendingHandoff.current;
            if (target) void performHandoff(target);
          }, 250);
        }
      } catch (cause) {
        responses.push({
          id: call.id,
          name: call.name,
          response: { ok: false, error: cause instanceof Error ? cause.message : "The workspace tool failed." },
        });
      }
    }
    if (responses.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    }
  }

  function handleTurnComplete() {
    const wasInterrupted = interrupted.current;
    const assistantText = outputTranscript.current;
    const userText = inputTranscript.current;
    if (userText) {
      appendMessage("user", userText);
      void saveTurn("user", userText, wasInterrupted);
      inputTranscript.current = "";
    }
    if (assistantText) {
      const tokenDelta = consumeUsageDelta();
      appendMessage("assistant", assistantText);
      void saveTurn("assistant", assistantText, wasInterrupted, tokenDelta);
      outputTranscript.current = "";
    }
    setPartialUser("");
    setPartialAssistant("");
    turnTaskIds.current = [];
    turnId.current = makeId("turn-");
    if (wasInterrupted && manualInterrupt.current) {
      // Keep the interrupted turn muted until the next deliberate user utterance.
      interrupted.current = true;
      ignoreAudio.current = true;
    } else {
      manualInterrupt.current = false;
      interrupted.current = false;
      ignoreAudio.current = false;
    }
    const context = playbackContext.current;
    const remaining = context ? Math.max(0, (nextPlaybackAt.current - context.currentTime) * 1000) : 0;
    if (remaining > 120) {
      if (playbackDrainTimer.current) clearTimeout(playbackDrainTimer.current);
      playbackDrainTimer.current = setTimeout(() => {
        playbackDrainTimer.current = null;
        if (mounted.current && !ignoreAudio.current) setState("listening");
      }, Math.min(8000, remaining + 80));
    } else {
      setState("listening");
    }
    const target = pendingHandoff.current;
    if (target) void performHandoff(target);
  }

  async function handleSocketMessage(raw: string | Blob | ArrayBuffer) {
    let text = "";
    if (typeof raw === "string") text = raw;
    else if (raw instanceof Blob) text = await raw.text();
    else text = new TextDecoder().decode(raw);
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if (message.setupComplete) {
      reconnectAttempts.current = 0;
      setState("listening");
      setError("");
      const ready = await ensureMicrophone();
      if (!ready) {
        closeSocket();
        setState("error");
        return;
      }
      if (greetingRef.current) {
        const isCoordinator = activeAgentRef.current === "coordinator";
        const request = isCoordinator
          ? "[Session control: the live voice session has just opened. Greet the owner briefly in your own voice, then wait for their instruction.]"
          : `[Session control: the owner has just been handed to you, ${AGENT_LABELS[activeAgentRef.current]}. Greet them briefly in character, state your role in one sentence, and wait.]`;
        wsRef.current?.send(
          JSON.stringify({
            clientContent: { turns: [{ role: "user", parts: [{ text: request }] }], turnComplete: true },
          }),
        );
        greetingRef.current = false;
      }
      return;
    }

    const serverContent = message.serverContent as
      | {
          modelTurn?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string }> };
          interrupted?: boolean;
          turnComplete?: boolean;
          waitingForInput?: boolean;
          inputTranscription?: { text?: string };
          interimInputTranscription?: { text?: string };
          outputTranscription?: { text?: string };
        }
      | undefined;

    if (serverContent) {
      if (serverContent.interrupted) {
        interrupted.current = true;
        ignoreAudio.current = true;
        stopPlayback();
        setState("interrupted");
      }
      if (serverContent.modelTurn?.parts) {
        for (const part of serverContent.modelTurn.parts) {
          if (part.inlineData?.data) playPcm(part.inlineData.data);
          if (part.text) {
            outputTranscript.current += part.text;
            setPartialAssistant(outputTranscript.current);
          }
        }
      }
      if (serverContent.inputTranscription?.text) {
        inputTranscript.current += serverContent.inputTranscription.text;
        setPartialUser(inputTranscript.current);
      }
      if (serverContent.interimInputTranscription?.text) {
        setPartialUser(serverContent.interimInputTranscription.text);
      }
      if (serverContent.outputTranscription?.text) {
        outputTranscript.current += serverContent.outputTranscription.text;
        setPartialAssistant(outputTranscript.current);
      }
      if (serverContent.waitingForInput && !serverContent.turnComplete) {
        setState("listening");
      }
      if (serverContent.turnComplete) handleTurnComplete();
    }

    if (message.toolCall) {
      const functionCalls = (message.toolCall as { functionCalls?: ToolCall[] }).functionCalls ?? [];
      await runTool(functionCalls);
    }

    const usageMessage = message.usageMetadata as
      | { promptTokenCount?: number; responseTokenCount?: number; totalTokenCount?: number }
      | undefined;
    if (usageMessage) {
      const nextUsage = {
        prompt: usageMessage.promptTokenCount ?? 0,
        response: usageMessage.responseTokenCount ?? 0,
        total: usageMessage.totalTokenCount ?? 0,
      };
      usageRef.current = nextUsage;
      setUsage(nextUsage);
    }

    const resumption = message.sessionResumptionUpdate as { newHandle?: string; resumable?: boolean } | undefined;
    if (resumption?.resumable && resumption.newHandle) resumptionHandle.current = resumption.newHandle;

    const goAway = message.goAway as { timeLeft?: string } | undefined;
    if (goAway) setNotice("Google is rotating the live session. Reconnecting automatically…");
  }

  function closeSocket(): void {
    wsGeneration.current += 1;
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState < WebSocket.CLOSING) {
      intentionalClose.current = true;
      ws.close(1000, "Client ended the session");
    }
  }

  function scheduleReconnect(): void {
    if (intentionalClose.current || !mounted.current || stateRef.current === "error") return;
    if (reconnectAttempts.current >= 3) {
      flushTranscripts();
      stopPlayback();
      void stopMicrophone();
      setError("The live connection ended and could not be restored. Check your network and free-tier availability, then start again.");
      setState("error");
      return;
    }
    reconnectAttempts.current += 1;
    const delay = Math.min(6000, 800 * 2 ** (reconnectAttempts.current - 1));
    setState("connecting");
    setNotice(`Connection lost. Reconnecting (${reconnectAttempts.current}/3)…`);
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    reconnectTimer.current = setTimeout(() => {
      void startLive(activeAgentRef.current, { greet: false, fresh: false, preserveMessages: true });
    }, delay);
  }

  function connectSocket(payload: SessionPayload, generation: number) {
    const ws = new WebSocket(payload.wsUrl);
    wsRef.current = ws;
    intentionalClose.current = false;
    const setup = {
      ...payload.setup,
      sessionResumption: resumptionHandle.current ? { handle: resumptionHandle.current } : {},
    };
    ws.onopen = () => {
      if (generation !== wsGeneration.current) return;
      ws.send(JSON.stringify({ setup }));
    };
    ws.onmessage = (event) => {
      if (generation !== wsGeneration.current) return;
      void handleSocketMessage(event.data as string | Blob | ArrayBuffer);
    };
    ws.onerror = () => {
      if (generation !== wsGeneration.current) return;
      setNotice("The live connection reported an error.");
    };
    ws.onclose = (event) => {
      if (generation !== wsGeneration.current || intentionalClose.current) return;
      flushTranscripts();
      if (event.code === 1008 || /quota|billing|permission|not found|invalid/i.test(event.reason ?? "")) {
        void stopMicrophone();
        stopPlayback();
        setError(
          event.reason?.trim()
            ? `Live voice stopped: ${event.reason.trim()}`
            : "Gemini Live rejected the session. Check the key, model availability and free-tier quota. No paid fallback was attempted.",
        );
        setState("error");
        return;
      }
      scheduleReconnect();
    };
  }

  async function requestToken(agentKey: AgentKey, greet: boolean): Promise<SessionPayload> {
    const response = await fetch("/api/voice/live/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentKey,
        sessionId: sessionIdRef.current,
        greet,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as SessionPayload & { error?: string; code?: string };
    if (!response.ok) {
      const message =
        payload.code === "LIVE_NOT_CONFIGURED"
          ? payload.error ?? "Live voice is not configured."
          : response.status === 429
            ? "Gemini Live free-tier quota is exhausted or cooling down. No paid fallback was attempted."
            : payload.error ?? "The live voice session could not start.";
      throw new Error(message);
    }
    if (!payload.wsUrl || !payload.setup) throw new Error("The live voice session was incomplete.");
    sessionIdRef.current = payload.sessionId;
    setModel(payload.model || "Gemini Live");
    try {
      window.sessionStorage.setItem(SESSION_KEY, payload.sessionId);
    } catch {
      // Ignore private-mode storage failures.
    }
    return payload;
  }

  async function startLive(
    agentKey: AgentKey = "coordinator",
    options: { greet?: boolean; fresh?: boolean; preserveMessages?: boolean } = {},
  ) {
    if (starting.current) return;
    starting.current = true;
    manualInterrupt.current = false;
    interruptQuietSince.current = 0;
    interruptReadyForUser.current = false;
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    if (!options.preserveMessages) {
      setUsage(null);
      usageRef.current = null;
      reportedUsage.current = { prompt: 0, response: 0, total: 0 };
      resumptionHandle.current = "";
    }
    if (options.fresh) {
      sessionIdRef.current = makeId("voice_");
      usageRef.current = null;
      reportedUsage.current = { prompt: 0, response: 0, total: 0 };
      resumptionHandle.current = "";
      try {
        window.sessionStorage.setItem(SESSION_KEY, sessionIdRef.current);
      } catch {
        // Ignore.
      }
    }
    if (!sessionIdRef.current) sessionIdRef.current = makeId("voice_");
    if (options.fresh) reconnectAttempts.current = 0;
    intentionalClose.current = false;
    setActiveAgent(agentKey);
    activeAgentRef.current = agentKey;
    setError("");
    setNotice("");
    setState("connecting");
    stopPlayback();
    greetingRef.current = Boolean(options.greet);
    ensurePlayback();
    closeSocket();
    intentionalClose.current = false;
    const generation = wsGeneration.current;
    try {
      const payload = await requestToken(agentKey, Boolean(options.greet));
      if (generation !== wsGeneration.current) {
        starting.current = false;
        return;
      }
      connectSocket(payload, generation);
      starting.current = false;
    } catch (cause) {
      starting.current = false;
      setError(cause instanceof Error ? cause.message : "Live voice could not start.");
      setState("error");
    }
  }

  function endSession() {
    intentionalClose.current = true;
    manualInterrupt.current = false;
    interruptQuietSince.current = 0;
    interruptReadyForUser.current = false;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    if (handoffTimer.current) clearTimeout(handoffTimer.current);
    closeSocket();
    flushTranscripts();
    stopPlayback();
    void stopMicrophone();
    setState("disconnected");
    setMuted(false);
    micMuted.current = false;
    setNotice("");
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      if (!mounted.current || wsRef.current) return;
      setState("idle");
    }, 2600);
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    micMuted.current = next;
    const track = micStream.current?.getAudioTracks()[0];
    if (track) track.enabled = !next;
    if (!next) void micContext.current?.resume();
  }

  function interrupt() {
    if (state !== "speaking" && state !== "interrupted") return;
    ignoreAudio.current = true;
    interrupted.current = true;
    manualInterrupt.current = true;
    interruptReadyForUser.current = micLevel.current < 0.003;
    interruptQuietSince.current = interruptReadyForUser.current ? performance.now() : 0;
    stopPlayback();
    setState("interrupted");
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      // Gemini 3.8 treats a client turn completion as a generation interrupt.
      ws.send(JSON.stringify({ clientContent: { turnComplete: true } }));
    }
  }

  function closePanel() {
    if (live) endSession();
    setOpen(false);
  }

  function handleTrigger() {
    if (open) {
      closePanel();
      return;
    }
    setLegacyOpen(false);
    setOpen(true);
    if (state === "idle" || state === "disconnected" || state === "error") {
      void startLive(activeAgentRef.current, { greet: true, fresh: true, preserveMessages: false });
    }
  }

  useEffect(() => {
    return () => {
      mounted.current = false;
      intentionalClose.current = true;
      wsGeneration.current += 1;
      wsRef.current?.close(1000, "Component unmounted");
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (handoffTimer.current) clearTimeout(handoffTimer.current);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (playbackDrainTimer.current) clearTimeout(playbackDrainTimer.current);
      orbLevels.current.input = 0;
      orbLevels.current.output = 0;
      stopPlayback();
      void stopMicrophone();
      const context = playbackContext.current;
      playbackContext.current = null;
      if (context && context.state !== "closed") void context.close();
    };
  }, []);

  const status = STATUS[state];
  const live = state !== "idle" && state !== "disconnected" && state !== "error";
  const connected = state === "listening" || state === "speaking" || state === "processing" || state === "interrupted";
  const badgeTone = state === "error" ? "badge-bad" : state === "speaking" || state === "listening" ? "badge-good" : "badge-info";
  const activeProfile = voiceProfileForAgent(activeAgent);
  const activeRole = agentDefinition(activeAgent)?.role ?? "Specialist";
  const orbState: OrbState = state === "idle" ? "IDLE"
    : state === "connecting" ? "CONNECTING"
      : state === "listening" ? "LISTENING"
        : state === "processing" ? "THINKING"
          : state === "speaking" ? "SPEAKING"
            : state === "interrupted" ? "INTERRUPTED"
              : state === "disconnected" ? "DISCONNECTED" : "ERROR";

  return (
    <>
      <button
        type="button"
        className={`header-cta voice-trigger ${open ? "active" : ""}`}
        aria-label="Open AT Voice Assistant"
        title="AT Voice Assistant"
        aria-expanded={open}
        onClick={handleTrigger}
      >
        <span className="lv-trigger-glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M8 8.2c1.5-2.7 6.5-2.7 8 0M7 11.2c0 4 1.6 6.8 5 6.8s5-2.8 5-6.8" />
            <path d="M9.2 11.3h1.6M13.2 11.3h1.6M10.2 14.6c1.1.6 2.5.6 3.6 0" />
            <path d="M6.8 9.5C5 7.8 4.6 5.5 5.5 3M17.2 9.5c1.8-1.7 2.2-4 1.3-6.5" />
          </svg>
        </span>
        <span className="header-cta-label">Live voice</span>
        <span className="voice-trigger-dot" data-live={live} />
      </button>

      {open && typeof document !== "undefined" ? createPortal(
        <div className="lv-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePanel(); }}>
          <section className="lv-panel" role="dialog" aria-modal="true" aria-label={`${AGENT_LABELS[activeAgent]} live voice`}>
            <header className="lv-head">
              <div className="lv-title">
                <span className="lv-head-mark" aria-hidden="true"><i /></span>
                <div className="min-w-0">
                  <div className="lv-eyebrow">AT AI AGENCY <span>· {activeAgent === "coordinator" ? "Chief Coordinator" : activeRole}</span></div>
                  <h2>{AGENT_LABELS[activeAgent]}</h2>
                </div>
              </div>
              <div className="lv-head-actions">
                <span className={`badge ${badgeTone}`}>{status.label}</span>
                <button type="button" className="lv-icon-btn" aria-label="Close live voice and end session" onClick={closePanel}>✕</button>
              </div>
            </header>

            <div className={`lv-hero ${state}`} ref={heroRef}>
              <div className="lv-avatar" aria-hidden="true">
                <CosmicOrb state={orbState} levelsRef={orbLevels} compact={compactOrb} />
              </div>
              <div className="lv-wave" role="img" aria-label="Live audio activity">
                {[0, 1, 2, 3, 4, 5, 6].map((index) => (
                  <span key={index} className="lv-bar" aria-hidden="true" />
                ))}
              </div>
              <div className="lv-status" aria-live="polite">
                <strong>{AGENT_LABELS[activeAgent]} — {status.label}</strong>
                <span>{status.hint}</span>
              </div>
              <div className="lv-meta">
                <span className={`lv-presence ${connected ? "online" : ""}`}><i /> {connected ? "Connected" : state === "connecting" ? "Connecting" : "Not connected"}</span>
                <span className={`lv-mic ${muted ? "is-muted" : live ? "is-live" : ""}`}><i /> {muted ? "Mic muted" : live ? "Mic live" : "Mic idle"}</span>
                <span>{activeProfile.voiceName} · {model}</span>
                <span>English</span>
              </div>
            </div>

            {error ? (
              <div className="lv-alert" role="alert">
                <strong>Live voice unavailable</strong>
                <p>{error}</p>
                <div className="lv-alert-actions">
                  <Link href="/assistant" className="btn btn-sm">Open text assistant</Link>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => void startLive(activeAgent, { greet: true, fresh: true })}>Try again</button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      endSession();
                      setOpen(false);
                      setLegacyOpen(true);
                    }}
                  >
                    Classic voice
                  </button>
                </div>
              </div>
            ) : notice ? <div className="lv-notice">{notice}</div> : null}

            <div className="lv-transcript" ref={scrollRef}>
              {messages.length === 0 && !partialUser && !partialAssistant ? (
                <div className="lv-empty">
                  <p>One click starts a continuous conversation with {AGENT_LABELS[activeAgent]}. Speak naturally, pause, or interrupt at any time.</p>
                  <p className="hint">{activeAgent === "coordinator" ? "Try: “How many agents are working, and which models are they using?” or “Transfer me to the research agent.”" : `You are speaking directly with ${activeRole} using ${activeProfile.voiceName}. Say “return to the coordinator” to go back.`}</p>
                </div>
              ) : (
                messages.slice(-8).map((message) => (
                  <div key={message.id} className={`lv-msg ${message.role === "user" ? "is-user" : "is-assistant"}`}>
                    <div className="lv-msg-role">{message.role === "user" ? "You" : AGENT_LABELS[message.agentKey ?? activeAgent]}</div>
                    <div>{message.content}</div>
                  </div>
                ))
              )}
              {partialUser ? <div className="lv-msg is-user is-live"><div className="lv-msg-role">You · live</div><div>{partialUser}</div></div> : null}
              {partialAssistant ? <div className="lv-msg is-assistant is-live"><div className="lv-msg-role">{AGENT_LABELS[activeAgent]} · live</div><div>{partialAssistant}</div></div> : null}
              {state === "processing" ? <div className="lv-thinking"><span className="dot" /> Coordinating…</div> : null}
            </div>

            <footer className="lv-controls">
              <div className="lv-main-controls">
                {live ? (
                  <>
                    <button type="button" className="btn btn-primary lv-main-btn" onClick={toggleMute} disabled={state === "connecting"}>
                      {muted ? "Unmute" : "Mute"}
                    </button>
                    <button type="button" className="btn lv-main-btn" onClick={interrupt} disabled={state !== "speaking" && state !== "interrupted"}>
                      Interrupt
                    </button>
                    <button type="button" className="btn btn-danger lv-main-btn" onClick={endSession}>
                      End
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn-primary lv-start-btn" onClick={() => void startLive(activeAgent, { greet: true, fresh: true })}>
                    Start live conversation
                  </button>
                )}
              </div>
              <div className="lv-options">
                <span className="lv-usage">Voice {activeProfile.voiceName} · assigned to {AGENT_LABELS[activeAgent]}</span>
                {usage ? <span className="lv-usage">{usage.total.toLocaleString("en-GB")} session tokens</span> : null}
                <Link href="/assistant" className="lv-text-link">Text chat</Link>
              </div>
              <p className="lv-privacy">
                Continuous audio is sent directly to Google Gemini Live with a short-lived token. Each agent has a fixed server-assigned voice; switching agents switches the voice immediately. Raw microphone recordings are not stored; only completed transcripts are saved.
              </p>
            </footer>
          </section>
        </div>,
        document.body,
      ) : null}
      {legacyOpen && typeof document !== "undefined" ? createPortal(
        <VoiceAssistant
          initialMessages={messages}
          hideTrigger
          defaultOpen
          onClose={() => setLegacyOpen(false)}
        />,
        document.body,
      ) : null}
    </>
  );
}
