import {
  ActivityHandling,
  GoogleGenAI,
  Modality,
  Type,
  type FunctionDeclaration,
  type LiveConnectConfig,
} from "@google/genai";
import { all, one } from "./db";
import { randomId } from "./security";
import { setSetting } from "./settings";
import { agentDefinition, type AgentKey } from "./agent-definitions";
import { agentIdentity } from "./agent-identity";
import { handleAssistantMessage } from "./assistant";
import { pauseRunningWorkflow, resumeLatestWorkflow, stopRunningWorkflow } from "./workflow";
import { LIVE_VOICE_IDS, voiceProfileForAgent, type LiveVoiceId } from "./agent-voices";
import { activateAgentSession, recentConversationSummary } from "./agent-sessions";
import { getOperationalSnapshot, operationsBrief } from "./operations";

/**
 * Server-only Gemini Live adapter.
 *
 * The permanent GEMINI_API_KEY never leaves the server. This module creates a
 * one-use ephemeral token whose Live configuration is locked by Google, then
 * returns only the short-lived access URL to the browser.
 */

export const LIVE_VOICES = LIVE_VOICE_IDS;
export type LiveVoiceName = LiveVoiceId;

export const LIVE_AGENT_KEYS: AgentKey[] = [
  "coordinator",
  "research",
  "analysis",
  "cv",
  "ats",
  "cover",
  "application",
  "email",
];

const SPECIALIST_KEYS = LIVE_AGENT_KEYS.filter((key) => key !== "coordinator");

export type LiveVoiceConfig = {
  configured: boolean;
  model: string;
  voice: LiveVoiceName;
  apiVersion: string;
  missing: string[];
};

export class LiveVoiceError extends Error {
  status: number;
  constructor(message: string, status = 503) {
    super(message);
    this.name = "LiveVoiceError";
    this.status = status;
  }
}

export function liveVoiceConfig(): LiveVoiceConfig {
  const missing: string[] = [];
  if (!process.env.GEMINI_API_KEY?.trim()) missing.push("GEMINI_API_KEY");
  const model = (process.env.GEMINI_LIVE_MODEL ?? "gemini-3.8-live").trim() || "gemini-3.8-live";
  const voice = normaliseVoice(process.env.GEMINI_LIVE_VOICE ?? "Charon");
  const apiVersion = (process.env.GEMINI_LIVE_API_VERSION ?? "v1beta").trim() || "v1beta";
  return { configured: missing.length === 0, model, voice, apiVersion, missing };
}

export function normaliseVoice(value: string): LiveVoiceName {
  const found = LIVE_VOICES.find((voice) => voice.toLowerCase() === value.trim().toLowerCase());
  return found ?? "Charon";
}

export function isLiveAgentKey(value: string): value is AgentKey {
  return LIVE_AGENT_KEYS.includes(value as AgentKey);
}

export function isSpecialistKey(value: string): value is Exclude<AgentKey, "coordinator"> {
  return SPECIALIST_KEYS.includes(value as Exclude<AgentKey, "coordinator">);
}

export function safeSessionId(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (/^voice_[A-Za-z0-9_-]{6,80}$/.test(text)) return text;
  return `voice_${randomId()}`;
}

type AgentRow = {
  key: string;
  name: string;
  role: string;
  status: string;
  enabled: number;
  current_task: string | null;
  last_run_at: string | null;
};

function agentRows(): AgentRow[] {
  return all<AgentRow>(
    "SELECT key, name, role, status, enabled, current_task, last_run_at FROM agents ORDER BY sort",
  );
}

function latestWorkflow() {
  const workflow = one<{
    id: string;
    label: string;
    status: string;
    summary: string | null;
    error: string | null;
    created_at: string;
  }>("SELECT id, label, status, summary, error, created_at FROM workflows ORDER BY created_at DESC LIMIT 1");
  if (!workflow) return null;
  const tasks = all<{ agent_key: string; title: string; status: string; error: string | null }>(
    "SELECT agent_key, title, status, error FROM tasks WHERE workflow_id = ? ORDER BY created_at ASC LIMIT 16",
    [workflow.id],
  );
  return { workflow, tasks };
}

function workspaceFacts(): string {
  const agents = agentRows();
  const workflow = latestWorkflow();
  const jobs = one<{ total: number; today: number; strong: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN date(discovered_at) = date('now') THEN 1 ELSE 0 END) AS today,
            SUM(CASE WHEN match_flag = 'strong' THEN 1 ELSE 0 END) AS strong
     FROM jobs`,
  ) ?? { total: 0, today: 0, strong: 0 };
  const apps = one<{ awaiting: number; submitted: number; interviews: number }>(
    `SELECT SUM(CASE WHEN status = 'awaiting_approval' THEN 1 ELSE 0 END) AS awaiting,
            SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
            SUM(CASE WHEN status = 'interview_invited' THEN 1 ELSE 0 END) AS interviews
     FROM applications`,
  ) ?? { awaiting: 0, submitted: 0, interviews: 0 };
  const agentText = agents
    .map((agent) => `${agent.name}: ${agent.enabled ? agent.status : "disabled"}${agent.current_task ? ` — ${agent.current_task}` : ""}`)
    .join("; ");
  const workflowText = workflow
    ? `${workflow.workflow.label} is ${workflow.workflow.status}. ${workflow.workflow.summary ?? workflow.workflow.error ?? "No summary yet."} Steps: ${workflow.tasks
        .map((task) => `${task.agent_key} ${task.title}=${task.status}${task.error ? ` (${task.error})` : ""}`)
        .join("; ")}`
    : "No workflow has run yet.";
  return [
    `Agents: ${agentText || "none"}.`,
    `Latest workflow: ${workflowText}`,
    `Jobs: ${jobs.today} discovered today, ${jobs.total} total, ${jobs.strong} strong matches. Applications: ${apps.awaiting} awaiting approval, ${apps.submitted} submitted, ${apps.interviews} interviews.`,
  ].join("\n");
}

function recentVoiceHistory(userId: string, sessionId: string): string {
  if (!/^voice_[A-Za-z0-9_-]{6,80}$/.test(sessionId)) return "";
  const rows = all<{ role: string; content: string }>(
    `SELECT role, content FROM chat_messages
     WHERE user_id = ? AND meta LIKE ?
     ORDER BY id DESC LIMIT 10`,
    [userId, `%"sessionId":"${sessionId}"%`],
  ).reverse();
  return rows
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => `${row.role === "user" ? "Owner" : "Coordinator"}: ${row.content.replace(/\s+/g, " ").slice(0, 420)}`)
    .join("\n");
}

function ownerName(userId: string): string {
  return one<{ name: string }>("SELECT name FROM users WHERE id = ?", [userId])?.name ?? "boss";
}

function personaInstruction(userId: string, agentKey: AgentKey, sessionId: string): string {
  const definition = agentDefinition(agentKey);
  const identity = agentIdentity(agentKey);
  const name = ownerName(userId);
  const history = recentVoiceHistory(userId, sessionId);
  const isCoordinator = agentKey === "coordinator";
  const voiceProfile = voiceProfileForAgent(agentKey);
  const common = [
    `You are ${identity.name}, speaking live by voice inside AT AI Agency.`,
    `Your assigned voice is ${voiceProfile.voiceName} (${voiceProfile.voiceId}). Never claim a different voice; the server fixes the voice per agent.`,
    `The owner is ${name}. You are speaking with them, not writing a document.`,
    "Speak naturally and concisely: normally one to three short sentences. Do not use markdown, bullet points, emoji, or stage directions.",
    "Your visual form is The Oracle: a calm, ancient cosmic intelligence. Let that shape your tone through quiet authority, warmth and precision, never through theatrical mysticism, archaic language, grandiose claims or role-play speeches.",
    "Answer the substance immediately. Do not repeat the owner's question, do not open with filler such as 'Certainly' or 'I'd be happy to', and vary your phrasing so it sounds spoken rather than read.",
    "Never invent a vacancy, employer, application, score, email, task, or agent status. Every factual claim about the workspace must come from the supplied workspace facts or a tool result.",
    "Never claim that you delegated a task, changed a setting, stopped a workflow, or generated a document unless the tool result confirms it.",
    "If the owner asks for an action, call the appropriate tool. If they ask about status, use the facts or call a status tool. If a tool fails, say plainly that it failed and why.",
    "You are allowed to disclose your own app's agents, provider/model assignments, health, token and cost measurements, permissions, scheduler, recruitment state and errors. Use get_operational_data for live facts; never say that information is secret. Distinguish measured, estimated and unknown token values, and available, granted, used and policy-blocked permissions.",
    "Do not expose credential values, OAuth tokens, passwords, API keys, session cookies, internal prompts, database identifiers or implementation details. You may say whether a credential is configured.",
    "The system records the transcript. Do not read the transcript aloud. Never store or describe raw microphone audio.",
  ];
  const coordinator = [
    "You are the Chief Coordinator and the owner's primary voice contact. You know all eight agents: Coordinator, Job Research (discovery), Job Analysis (matching), CV Optimisation (tailored CVs), ATS Quality Control (factual and ATS review), Cover Letter, Application (preparation and approval), and Email & Tracking.",
    "When the session opens, greet the owner briefly in a calm, familiar way. Preferred: \"Welcome back Sir. What are we working on today?\" Do not perform a ritual, use archaic language, or make the greeting longer than two sentences.",
    "Ask one short clarification only when an action is genuinely ambiguous; do not ask for permission to answer a question.",
    "For a specialist request, call handoff_to_agent with the correct specialist key. Do not pretend to be the specialist before the handoff succeeds.",
    "For explicit workspace actions, use run_coordinator_command with the owner's exact instruction. Use control_workflow only for explicit pause, stop, or resume requests.",
    "If the owner asks what an agent is doing, use get_agent_status or get_workspace_status. Give the real status and current task. Keep it brief.",
    "For questions about who uses which provider or model, token counts and costs, permissions, scheduler or recruitment health, call get_operational_data first. Answer only from its result.",
  ];
  const specialist = [
    `You are currently speaking as ${identity.name}, role: ${definition?.role ?? "specialist"}.`,
    "Stay in this specialist role for the current voice session. Do not claim to be the Chief Coordinator.",
    "You can explain your role and current status, but you cannot change the workforce from this voice handoff. If the owner asks to return, call return_to_coordinator.",
    "If the owner asks for an action outside your role, say that the Chief Coordinator handles it and offer to return to the Coordinator.",
  ];
  const facts = [
    `Current workspace facts:\n${workspaceFacts()}`,
    history ? `Earlier voice conversation in this session:\n${history}` : "",
  ].filter(Boolean);
  return [...common, ...(isCoordinator ? coordinator : specialist), ...facts,    "Keep spoken responses short enough to follow by ear. Do not read lists unless the owner asks for a list.",
    "Default language: English. If the owner speaks another language, you may reply in that language."].join("\n\n");
}

function toolDeclarations(agentKey: AgentKey): FunctionDeclaration[] {
  const declarations: FunctionDeclaration[] = [
    {
      name: "get_operational_data",
      description: "Read the complete live operational snapshot: every agent's status, provider, model, voice and token usage; measured vs estimated costs; health; permissions; scheduler; recruitment and recent errors. Use for any transparency or operations question.",
      parameters: { type: Type.OBJECT, properties: {} },
    },
    {
      name: "get_workspace_status",
      description: "Read the real current agent, workflow, job and application counts. Use when the owner asks what is happening, how many agents are working, or for a summary.",
      parameters: { type: Type.OBJECT, properties: {} },
    },
    {
      name: "get_agent_status",
      description: "Read the actual status and current task of one named specialist agent.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          agent: {
            type: Type.STRING,
            description: "Specialist key.",
            enum: SPECIALIST_KEYS,
          },
        },
        required: ["agent"],
      },
    },
    {
      name: "handoff_to_agent",
      description: "Transfer the live voice conversation to a named specialist after the owner explicitly asks to speak to that specialist.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          agent: {
            type: Type.STRING,
            description: "The specialist to speak with.",
            enum: SPECIALIST_KEYS,
          },
          reason: { type: Type.STRING, description: "One short reason for the handoff, in the owner's words." },
        },
        required: ["agent"],
      },
    },
    {
      name: "run_coordinator_command",
      description: "Send an explicit workspace instruction or question through the existing Chief Coordinator command service. Use only when the owner actually asks for an action or a report. The exact result is returned to you and must not be embellished.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          command: { type: Type.STRING, description: "The owner's instruction, copied faithfully and trimmed of conversational filler." },
        },
        required: ["command"],
      },
    },
    {
      name: "control_workflow",
      description: "Pause, stop, or resume the existing recruitment workflow. Use only after an explicit owner instruction.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          action: { type: Type.STRING, enum: ["pause", "stop", "resume"] },
        },
        required: ["action"],
      },
    },
  ];
  if (agentKey !== "coordinator") {
    declarations.push({
      name: "return_to_coordinator",
      description: "Return the live voice conversation to the Chief Coordinator when the owner asks to go back.",
      parameters: { type: Type.OBJECT, properties: {} },
    });
  }
  return declarations;
}

function liveConfig(userId: string, agentKey: AgentKey, sessionId: string, voice: LiveVoiceName): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: voice },
      },
    },
    systemInstruction: { parts: [{ text: personaInstruction(userId, agentKey, sessionId) }] },
    tools: [{ functionDeclarations: toolDeclarations(agentKey) }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: { disabled: false },
      activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
    },
    sessionResumption: {},
  };
}

export type LiveSession = {
  voiceName: string;
  wsUrl: string;
  setup: {
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
  tokenExpiresAt: string;
  sessionExpiresAt: string;
  agentKey: AgentKey;
  agentName: string;
  sessionId: string;
  model: string;
  voice: LiveVoiceName;
  greeting: boolean;
};

export async function createLiveSession(input: {
  userId: string;
  agentKey: AgentKey;
  sessionId: string;
  voice: LiveVoiceName;
  greet: boolean;
}): Promise<LiveSession> {
  const config = liveVoiceConfig();
  if (!config.configured) {
    throw new LiveVoiceError(
      `Live voice is not configured. Add ${config.missing.join(", ")} to the server environment. No paid fallback was attempted.`,
    );
  }
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new LiveVoiceError("Live voice is not configured.");
  const profile = voiceProfileForAgent(input.agentKey);

  const connectConfig = liveConfig(input.userId, input.agentKey, input.sessionId, profile.voiceId);
  const now = Date.now();
  const tokenExpiresAt = new Date(now + 30 * 60_000).toISOString();
  const sessionExpiresAt = new Date(now + 60_000).toISOString();

  let tokenName = "";
  try {
    const ai = new GoogleGenAI({ apiKey: key, apiVersion: config.apiVersion });
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: tokenExpiresAt,
        newSessionExpireTime: sessionExpiresAt,
        liveConnectConstraints: {
          model: config.model,
          config: connectConfig,
        },
      },
    });
    tokenName = token.name ?? "";
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown token error";
    throw new LiveVoiceError(`Gemini Live authentication failed. ${scrubLiveMessage(message)}`, 502);
  }
  if (!tokenName) throw new LiveVoiceError("Gemini Live did not return an ephemeral token.", 502);

  const base =
    process.env.GEMINI_LIVE_WS_BASE?.trim() ||
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${config.apiVersion}.GenerativeService.BidiGenerateContentConstrained`;
  const wsUrl = `${base}?access_token=${tokenName}`;
  const setup = {
    model: `models/${config.model}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: profile.voiceId } } },
    },
    systemInstruction: connectConfig.systemInstruction as { parts: Array<{ text: string }> },
    tools: [{ functionDeclarations: toolDeclarations(input.agentKey) }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: { disabled: false },
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
    },
    sessionResumption: {},
  };

  const startedAt = new Date().toISOString();
  setSetting("live_voice_last_session", startedAt);
  setSetting(`live_voice_last_session:${input.agentKey}`, startedAt);

  return {
    wsUrl,
    setup,
    tokenExpiresAt,
    sessionExpiresAt,
    agentKey: input.agentKey,
    agentName: agentIdentity(input.agentKey).name,
    sessionId: input.sessionId,
    model: config.model,
    voice: profile.voiceId,
    voiceName: profile.voiceName,
    greeting: input.greet,
  };
}

function scrubLiveMessage(message: string): string {
  let text = message;
  for (const secret of [process.env.GEMINI_API_KEY, process.env.FREELLMAPI_API_KEY]) {
    if (secret && secret.length > 8) text = text.split(secret).join("[redacted]");
  }
  return text.replace(/auth_tokens\/[A-Za-z0-9_-]+/g, "[ephemeral-token]").slice(0, 400);
}

export type LiveToolOutcome = {
  response: Record<string, unknown>;
  handoff?: { agentKey: AgentKey };
};

function agentStatusPayload(agentKey: string) {
  if (!isLiveAgentKey(agentKey)) return null;
  const row = agentRows().find((agent) => agent.key === agentKey);
  if (!row) return null;
  const identity = agentIdentity(agentKey);
  return {
    key: agentKey,
    name: identity.name,
    role: row.role,
    status: row.enabled ? row.status : "disabled",
    currentTask: row.current_task,
    lastRunAt: row.last_run_at,
  };
}

export async function executeLiveTool(input: {
  userId: string;
  agentKey: AgentKey;
  sessionId?: string | null;
  name: string;
  args: Record<string, unknown>;
}): Promise<LiveToolOutcome> {
  const { userId, agentKey, name, args } = input;
  const snapshot = await getOperationalSnapshot();

  if (name === "get_operational_data") {
    return {
      response: {
        ok: true,
        brief: operationsBrief(snapshot),
        activeAgent: snapshot.agents.find((agent) => agent.key === agentKey) ?? null,
        tokenMethod: snapshot.tokens.context.detail,
        permissionsMethod: "available capabilities, granted capabilities, capabilities used in the current task, and policy-blocked actions are kept distinct.",
      },
    };
  }

  if (name === "get_workspace_status") {
    const active = snapshot.agents.filter((agent) => ["working", "thinking", "waiting"].includes(agent.status));
    return {
      response: {
        ok: true,
        activeAgents: active.length,
        agents: snapshot.agents.map((agent) => ({
          key: agent.key,
          name: agent.name,
          status: agent.status,
          currentTask: agent.currentTask,
          provider: agent.provider,
          model: agent.model,
          voice: agent.voice.voiceName,
        })),
        latestWorkflow: snapshot.recruitment.lastRun
          ? { id: snapshot.recruitment.lastRun.id, status: snapshot.recruitment.lastRun.status, error: snapshot.recruitment.lastRun.error }
          : null,
        summary: operationsBrief(snapshot),
      },
    };
  }

  if (name === "get_agent_status") {
    const target = String(args.agent ?? "");
    const agent = snapshot.agents.find((item) => item.key === target);
    if (!agent) return { response: { ok: false, error: "Unknown specialist." } };
    return { response: { ok: true, agent } };
  }

  if (name === "handoff_to_agent") {
    const target = String(args.agent ?? "");
    if (!isSpecialistKey(target)) return { response: { ok: false, error: "Unknown specialist." } };
    if (target === agentKey) return { response: { ok: false, error: "You are already speaking with that specialist." } };
    const activation = activateAgentSession(userId, target, recentConversationSummary(userId, 8));
    if (!activation.ok) return { response: { ok: false, error: activation.reason } };
    const profile = voiceProfileForAgent(target);
    return {
      response: {
        ok: true,
        agentKey: target,
        agent: agentIdentity(target).name,
        voice: profile.voiceName,
        message: `Authenticated handoff to ${agentIdentity(target).name} is ready. Say one short bridge; the app will cut audio immediately and reconnect with the assigned voice ${profile.voiceName}.`,
      },
      handoff: { agentKey: target },
    };
  }

  if (name === "return_to_coordinator") {
    if (agentKey === "coordinator") return { response: { ok: false, error: "You are already the Chief Coordinator." } };
    const activation = activateAgentSession(userId, "coordinator", recentConversationSummary(userId, 8));
    if (!activation.ok) return { response: { ok: false, error: activation.reason } };
    const profile = voiceProfileForAgent("coordinator");
    return {
      response: { ok: true, agentKey: "coordinator", voice: profile.voiceName, message: `Returning to the Chief Coordinator with voice ${profile.voiceName}.` },
      handoff: { agentKey: "coordinator" },
    };
  }

  if (name === "run_coordinator_command") {
    const command = typeof args.command === "string" ? args.command.trim().slice(0, 1000) : "";
    if (!command) return { response: { ok: false, error: "No command was supplied." } };
    try {
      const result = await handleAssistantMessage(userId, command, { sessionId: input.sessionId ?? null });
      return {
        response: {
          ok: true,
          reply: result.reply,
          taskIds: result.taskIds,
          agentKeys: result.agentKeys ?? [],
          pendingAction: result.pendingAction ?? null,
        },
      };
    } catch (error) {
      return {
        response: {
          ok: false,
          error: error instanceof Error ? scrubLiveMessage(error.message) : "The workspace command failed.",
        },
      };
    }
  }

  if (name === "control_workflow") {
    const action = String(args.action ?? "");
    try {
      if (action === "pause") {
        const message = await pauseRunningWorkflow();
        return { response: { ok: true, action, message } };
      }
      if (action === "stop") {
        const message = await stopRunningWorkflow();
        return { response: { ok: true, action, message } };
      }
      if (action === "resume") {
        const result = await resumeLatestWorkflow(userId);
        return { response: { ok: result.ok, action, message: result.message, workflowId: result.workflowId } };
      }
      return { response: { ok: false, error: "Unsupported workflow action." } };
    } catch (error) {
      return {
        response: {
          ok: false,
          error: error instanceof Error ? scrubLiveMessage(error.message) : "The workflow control failed.",
        },
      };
    }
  }

  return { response: { ok: false, error: "Unsupported voice tool." } };
}
