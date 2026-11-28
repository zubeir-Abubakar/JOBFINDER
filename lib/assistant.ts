import { all, nowIso, one, run } from "./db";
import { getProfileData } from "./profile";
import { analysePendingJobs, analyseSingleJob, generateApplicationPackage, pauseAllAgents, runDiscovery, setAgentPaused } from "./agents";
import { cleanupExpiredDocuments } from "./retention";
import { statusLabel } from "./application-status";
import { agentIdentity, agentIdentityForName, agentKeysMentioned, agentRoster } from "./agent-identity";
import { generateText } from "./providers";
import { runResendTestEmail } from "./resend";
import { answerFromOperations, getOperationalSnapshot, operationsBrief } from "./operations";
import { latestWorkflowSnapshotForUser } from "./workflow-view";
import { latestPausedWorkflow, workflowActor } from "./workflow";
import { latestExecutiveBriefDelivery, refreshLatestExecutiveBriefDelivery, sendExecutiveBriefNow } from "./executive-brief";
import { isProfileQuestion, profileBrief } from "./profile-brief";
import { detectVisualIntent } from "./visual-companion";
import { explainVisualQuestion } from "./visual-context";
import type { VisualCommand } from "./visual-types";

export type AssistantPendingAction = "cleanup_expired";
export type AssistantResult = {
  reply: string;
  taskIds: string[];
  agentKeys?: string[];
  pendingAction?: AssistantPendingAction;
  /** Approved in-app navigation or highlight, dispatched by the browser host. */
  visual?: VisualCommand;
};

const HELP = `I can talk through your workspace and act on it. Try:
• "Hello" / "What should I do next?"
• "Which agents are currently working?"
• "Explain the latest workflow"
• "Summarise today's recruitment activity"
• "Find 20 Senior QA Engineer vacancies in Switzerland"
• "List vacancies" / "Show jobs above 80%"
• "Analyse the machineMD vacancy"
• "Generate a tailored CV for <company or job title>"
• "Review application packages"
• "Show recruiter messages"
• "Connect me to ${agentIdentity("research").name}" / "Return to ${agentIdentity("coordinator").name}"
• "How many tokens did we use today?" / "Is the system healthy?"
• "Pause ${agentIdentity("research").name}" / "Resume all agents"
• "Prioritise Lausanne and Geneva"
• "Daily report"
• "Send me today's Executive Brief now"
• "Has my Executive Brief been delivered?"`;

function normalise(text: string): string {
  return text.toLowerCase().trim();
}

function resolveAgent(text: string): string | null {
  const exact = agentIdentityForName(text);
  if (exact) return exact.key;
  const mentions = agentKeysMentioned(text);
  return mentions.length === 1 ? mentions[0] : null;
}

function identityMentioned(text: string) {
  const ordered = [...agentRoster()].sort((a, b) => b.name.length - a.name.length);
  return ordered.find((identity) => new RegExp(`\\b${identity.name}\\b`, "i").test(text)) ?? null;
}

function recentContext(userId: string, current: string): string {
  const rows = all<{ role: string; content: string }>(
    "SELECT role, content FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 10",
    [userId],
  ).reverse();
  const previous = rows.filter((row) => !(row.role === "user" && row.content.trim() === current.trim()));
  if (!previous.length) return "No previous messages in this conversation.";
  return previous
    .slice(-8)
    .map((row) => `${row.role === "user" ? "Owner" : "Coordinator"}: ${row.content.replace(/\s+/g, " ").slice(0, 500)}`)
    .join("\n");
}

function lastAssistantMeta(userId: string): { pendingAction?: AssistantPendingAction } {
  const row = one<{ meta: string | null }>(
    "SELECT meta FROM chat_messages WHERE user_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
    [userId],
  );
  if (!row?.meta) return {};
  try {
    return JSON.parse(row.meta) as { pendingAction?: AssistantPendingAction };
  } catch {
    return {};
  }
}

function ownerName(userId: string): string {
  return one<{ name: string }>("SELECT name FROM users WHERE id = ?", [userId])?.name ?? "there";
}

function agentSnapshot() {
  return all<{ key: string; name: string; status: string; enabled: number; current_task: string | null; last_run_at: string | null }>(
    "SELECT key, status, enabled, current_task, last_run_at FROM agents ORDER BY sort",
  ).map((agent) => ({ ...agent, name: agentIdentity(agent.key).name }));
}

function latestWorkflow(userId: string) {
  const snapshot = latestWorkflowSnapshotForUser(workflowActor(userId));
  if (!snapshot.workflow) return null;
  return { workflow: snapshot.workflow, tasks: snapshot.tasks.slice(0, 20) };
}

function todaySnapshot() {
  const jobs = one<{ total: number; today: number; analysed: number; strong: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN date(discovered_at) = date('now') THEN 1 ELSE 0 END) AS today,
            SUM(CASE WHEN match_score IS NOT NULL THEN 1 ELSE 0 END) AS analysed,
            SUM(CASE WHEN match_flag = 'strong' THEN 1 ELSE 0 END) AS strong
     FROM jobs`,
  ) ?? { total: 0, today: 0, analysed: 0, strong: 0 };
  const apps = one<{ awaiting: number; submitted_today: number; interviews: number }>(
    `SELECT SUM(CASE WHEN status = 'awaiting_approval' THEN 1 ELSE 0 END) AS awaiting,
            SUM(CASE WHEN submitted_at >= date('now') THEN 1 ELSE 0 END) AS submitted_today,
            SUM(CASE WHEN status = 'interview_invited' THEN 1 ELSE 0 END) AS interviews
     FROM applications`,
  ) ?? { awaiting: 0, submitted_today: 0, interviews: 0 };
  const tasks = one<{ completed_today: number; failed_today: number }>(
    `SELECT SUM(CASE WHEN status = 'completed' AND date(finished_at) = date('now') THEN 1 ELSE 0 END) AS completed_today,
            SUM(CASE WHEN status = 'failed' AND COALESCE(error_class, '') != 'blocked' AND date(finished_at) = date('now') THEN 1 ELSE 0 END) AS failed_today
     FROM tasks`,
  ) ?? { completed_today: 0, failed_today: 0 };
  const messages = one<{ c: number }>("SELECT COUNT(*) AS c FROM email_messages")?.c ?? 0;
  return { jobs, apps, tasks, messages };
}

function workspaceFacts(userId: string): string {
  const agents = agentSnapshot();
  const workflow = latestWorkflow(userId);
  const today = todaySnapshot();
  return [
    `Agents: ${agents.map((a) => `${a.name}=${a.enabled ? a.status : "disabled"}`).join("; ")}.`,
    workflow
      ? `Latest workflow: ${workflow.workflow.label} (${workflow.workflow.status}). ${workflow.workflow.summary ?? workflow.workflow.error ?? "No summary."} Steps: ${workflow.tasks.map((t) => `${t.agent_key} ${t.title}=${t.status}${t.error ? ` (${t.error})` : ""}`).join("; ")}.`
      : "No workflow has run yet.",
    `Today: ${today.jobs.today} jobs discovered, ${today.jobs.total} total, ${today.jobs.analysed} analysed, ${today.jobs.strong} strong. Applications awaiting approval: ${today.apps.awaiting}; submitted today: ${today.apps.submitted_today}; interview invitations: ${today.apps.interviews}. Tasks completed today: ${today.tasks.completed_today}; failed: ${today.tasks.failed_today}. Recruiter messages: ${today.messages}.`,
  ].join("\n");
}

function localGreeting(userId: string): string {
  const hour = new Date().getHours();
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const working = agentSnapshot().filter((a) => a.status === "working" || a.status === "thinking");
  return `Good ${part}, ${ownerName(userId).split(" ")[0]}. ${working.length ? `${working.length} agent(s) are currently active.` : "No agent is executing right now."} I can answer questions about the workspace or run a supported recruitment action. What would you like to do?`;
}

async function conversationalReply(userId: string, message: string, snapshot?: Awaited<ReturnType<typeof getOperationalSnapshot>>, sessionId?: string | null, onDelta?: (delta: string) => void): Promise<string> {
  const context = recentContext(userId, message);
  const live = snapshot ?? await getOperationalSnapshot();
  try {
    const result = await generateText({
      agentKey: "coordinator",
      // Conversation is not a workflow task, so it is attributed separately
      // instead of inflating the coordinator's task counters.
      source: "assistant",
      priority: 0,
      maxWaitMs: 8000,
      sessionId: sessionId ?? null,
      onDelta,
      system:
        `You are ${agentIdentity("coordinator").name}, the ${agentIdentity("coordinator").title} of a recruitment workspace. Use the agents' names in normal conversation, not internal keys: ${agentRoster().map((agent) => agent.name).join(", ")}. ` +
        "You may converse naturally, but every factual statement must be copied from the supplied workspace facts and operational snapshot; do not infer or add state changes, completed setup, enabled agents or next steps that are not literally present. Never invent vacancies, employers, applications, messages, scores, token totals or outcomes. Never claim an action was executed. Email delivery state must be copied from the supplied Executive Brief delivery fact: Gmail API acceptance is not inbox delivery, and an outbox row marked sent is not proof of delivery. Never say email sent, report delivered or check your inbox unless the persisted state is delivery_confirmed. Never say you cannot disclose your own application's agents, models, provider status, token usage, permissions or health: answer from the snapshot, while never exposing credential values. If a measurement is unavailable, say exactly what is unavailable. If the owner requests an operation, describe it as an available command and wait. If the owner greets you or asks how you are, answer briefly and naturally first; do not turn a greeting into a recruitment report. Do not introduce yourself again after the first turn, and never prefix a reply with your own name. Be warm, concise and practical. Use 2 short paragraphs at most.",
      prompt: `Owner message: ${message}\n\nWorkspace facts:\n${workspaceFacts(userId)}\n\nOperational snapshot:\n${operationsBrief(live)}\n\nRecent conversation:\n${context}`,
      maxTokens: 700,
      temperature: 0.4,
    });
    return result.text.trim();
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "the configured text provider is unavailable";
    if (/^(hi|hello|hey|good morning|good afternoon|good evening)\b/.test(normalise(message))) return localGreeting(userId);
    return `I couldn't complete that answer because ${reason.slice(0, 260)}. Your conversation is preserved — try again in a moment.`;
  }
}

function taskAgentKeys(): string[] {
  return ["coordinator", "research", "analysis", "cv", "ats", "cover", "application", "email"];
}

export async function handleAssistantMessage(
  userId: string,
  message: string,
  options: { sessionId?: string | null; view?: string | null; onDelta?: (delta: string) => void } = {},
): Promise<AssistantResult> {
  const text = normalise(message);
  const taskIds: string[] = [];
  const pending = lastAssistantMeta(userId).pendingAction;

  if (!text) return { reply: HELP, taskIds };
  if (/^(help|what can you do|commands)\b/.test(text)) return { reply: HELP, taskIds };

  // Destructive actions require a second, explicit confirmation in this conversation.
  if (pending && /^(yes|confirm|proceed|do it)\b/.test(text)) {
    if (pending === "cleanup_expired") {
      const result = await cleanupExpiredDocuments("assistant");
      return {
        reply: result.deleted > 0
          ? `Confirmed. Removed ${result.deleted} expired tailored document(s), freeing ${(result.bytes / 1024).toFixed(1)} KB. Original CV, profile and application history were not touched.`
          : "Confirmed, but no documents were eligible for deletion. Pinned documents and packages awaiting submission were preserved.",
        taskIds,
        agentKeys: ["cv", "cover"],
      };
    }
  }
  if (pending && /^(no|cancel|stop|don't|do not)\b/.test(text)) {
    return { reply: "Cancelled. Nothing was deleted or changed.", taskIds };
  }

  // Visual-understanding questions are answered from the actual stored charts,
  // tables, page data or owned document text before any model call. This is the
  // structured source of truth; a screenshot is never required when the data is
  // already available.
  const explanation = explainVisualQuestion(userId, message, options.view ?? undefined);
  if (explanation) {
    return { reply: explanation.reply, taskIds, agentKeys: explanation.agentKeys as AssistantResult["agentKeys"] };
  }

  // Explicit visual requests are resolved deterministically against real
  // records before any model call. This keeps navigation available even when a
  // provider is down and prevents invented ids or destinations.
  const visualIntent = detectVisualIntent(userId, message);
  if (visualIntent) return visualIntent;

  // Profile and CV questions are answered from the stored account records and
  // the extracted original CV, without sending personal data to a text model.
  if (isProfileQuestion(message)) {
    return { reply: profileBrief(), taskIds, agentKeys: ["coordinator"] };
  }

  const briefRequest = /\b(executive|daily)\s+(brief|report)\b/.test(text) || /\bexecutive brief\b/.test(text);
  const emailDeliveryQuestion =
    /\b(email|brief|report)\b/.test(text) &&
    /\b(sent|delivered|delivery|accepted|bounce|bounced|inbox|queued|generated)\b/.test(text) &&
    /\b(has|was|is|did|status|check|where|when|verify)\b/.test(text) &&
    !/\btest email\b/.test(text);

  if (briefRequest && /\b(send|email|deliver|resend|send again|retry|now)\b/.test(text)) {
    const result = await sendExecutiveBriefNow({
      userId,
      source: "coordinator",
      resend: /\b(resend|send again|try again|retry)\b/.test(text),
    });
    const details = [
      result.message,
      `Report ID: ${result.reportId}. Outbox ID: ${result.outboxId ?? "not created"}.`,
      `Delivery state: ${result.state}.`,
    ];
    if (result.messageId) details.push(`Gmail message ID: ${result.messageId}.`);
    if (result.lastError) details.push(`Recorded error: ${result.lastError}`);
    if (result.canResend) details.push("A deliberate resend is available after correcting the cause.");
    return { reply: details.join("\n"), taskIds, agentKeys: ["email", "coordinator"] };
  }

  if (briefRequest || emailDeliveryQuestion) {
    const latest = briefRequest || /\b(verify|sent folder|inbox)\b/.test(text)
      ? await refreshLatestExecutiveBriefDelivery()
      : latestExecutiveBriefDelivery();
    const details = [
      latest.message,
      `Report ID: ${latest.reportId}. Outbox ID: ${latest.outboxId ?? "not created"}. State: ${latest.state}.`,
    ];
    if (latest.messageId) details.push(`Gmail message ID: ${latest.messageId}${latest.threadId ? `; thread ${latest.threadId}` : ""}.`);
    if (latest.sentVerification) details.push(`Sent-folder check: ${latest.sentVerification}`);
    if (latest.lastError) details.push(`Last error: ${latest.lastError}`);
    if (latest.nextRetryAt) details.push(`Next retry: ${latest.nextRetryAt}.`);
    if (latest.canResend) details.push("The previous attempt definitively failed, was blocked, or bounced. Ask me to resend after correcting the cause; I will not resend automatically.");
    return { reply: details.join("\n"), taskIds, agentKeys: ["email", "coordinator"] };
  }

  if (/\b(send|trigger|run)\b.*\b(test|verification)\b.*\b(email|gmail)\b|\b(test email|verify gmail|gmail test)\b/.test(text)) {
    const to = (one<{ email: string | null }>("SELECT email FROM profiles WHERE id = 1")?.email ?? "").trim();
    if (!to) {
      return { reply: "No notification email is stored. Add the recipient in Settings first; the test cannot be aimed at an employer or an arbitrary address.", taskIds, agentKeys: ["email"] };
    }
    const result = await runResendTestEmail(to, userId);
    const accepted = result.status === "accepted" && Boolean(result.messageId);
    return {
      reply: accepted
        ? `Resend accepted one test email for ${result.recipientMasked}. Message ID ${result.messageId}. Provider acceptance is confirmed; inbox delivery is still unverified. No employer was contacted.`
        : `The test email was not accepted: ${result.status}. ${result.detail} No message was sent to an employer.`,
      taskIds,
      agentKeys: ["email"],
    };
  }

  const mentioned = identityMentioned(message);
  if (mentioned) {
    if (/\b(what|which|who)\b.*\b(submission|submit)\b/.test(text) && /\b(responsible|handles?|does)\b/.test(text)) {
      const noor = agentIdentity("application");
      return {
        reply: `${noor.name} handles application submission and confirmation verification. ${noor.title}.`,
        taskIds,
        agentKeys: ["application"],
      };
    }
    if (/\b(what|who)\b.*\b(is|does|do)\b.*\b(do|responsible|role)\b/.test(text) || /\bwhat does\b/.test(text)) {
      return {
        reply: `${mentioned.name} is your ${mentioned.title}. ${mentioned.responsibilities}`,
        taskIds,
        agentKeys: [mentioned.key],
      };
    }
    if (/\b(what|which)\b.*\b(has|have|did)\b.*\b(done|do|worked|completed)\b/.test(text) || /\bwhat has\b/.test(text)) {
      const today = new Date().toISOString().slice(0, 10);
      const done = all<{ title: string; status: string; output: string | null; error: string | null; finished_at: string | null }>(
        "SELECT title, status, output, error, finished_at FROM tasks WHERE agent_key = ? AND date(COALESCE(finished_at, created_at)) = ? ORDER BY created_at DESC LIMIT 12",
        [mentioned.key, today],
      );
      if (done.length === 0) {
        return {
          reply: `${mentioned.name} has no task recorded today. I will not invent work for ${mentioned.name}.`,
          taskIds,
          agentKeys: [mentioned.key],
        };
      }
      const completed = done.filter((task) => task.status === "completed");
      const failed = done.filter((task) => task.status === "failed");
      return {
        reply: `${mentioned.name} has ${done.length} task(s) recorded today: ${completed.length} completed, ${failed.length} failed.\n${done
          .slice(0, 8)
          .map((task) => `• ${task.title} — ${task.status}${task.error ? `: ${task.error}` : ""}`)
          .join("\n")}`,
        taskIds,
        agentKeys: [mentioned.key],
      };
    }
    if (/\b(who is|tell me about|introduce)\b/.test(text)) {
      return { reply: mentioned.introduction, taskIds, agentKeys: [mentioned.key] };
    }
  }

  if (/\b(which|who)\b.*\b(ai|agent)\b.*\b(submission|submit)\b/.test(text)) {
    const noor = agentIdentity("application");
    return { reply: `${noor.name} handles application submission and confirmation verification.`, taskIds, agentKeys: ["application"] };
  }

  if (/\b(which|who)\b.*\b(agents?|workforce)\b.*\b(working|active|busy)\b/.test(text)) {
    const agents = agentSnapshot();
    const active = agents.filter((a) => a.status === "working" || a.status === "thinking");
    const paused = agents.filter((a) => a.status === "paused");
    const idle = agents.filter((a) => a.status === "idle");
    return {
      reply: active.length
        ? `Currently active:\n${active.map((a) => `• ${a.name} — ${a.status === "thinking" ? "thinking (AI inference in progress)" : "working"}${a.current_task ? `: ${a.current_task}` : ""}`).join("\n")}`
        : `No agent is executing a task right now. ${idle.length} idle, ${paused.length} paused. Nothing is animated as Working unless its task record is actually running.`,
      taskIds,
      agentKeys: active.map((a) => a.key),
    };
  }

  if (/\b(explain|summar|what happened|status of)\b.*\b(latest|last|recent)?\b.*\bworkflow\b/.test(text) || /\blatest workflow\b/.test(text)) {
    const latest = latestWorkflow(userId);
    if (!latest) return { reply: "No workflow has run yet. Start a job search from the dashboard when you are ready.", taskIds };
    return {
      reply: `${latest.workflow.label} — ${latest.workflow.status}.\n${latest.workflow.summary ?? latest.workflow.error ?? "No summary was recorded."}\n\nSteps:\n${latest.tasks.map((task, i) => `${i + 1}. ${agentIdentity(task.agent_key).shortName}: ${task.title} — ${task.status}${task.error ? ` (${task.error})` : ""}`).join("\n") || "No task records."}`,
      taskIds,
      agentKeys: [...new Set(latest.tasks.map((t) => t.agent_key))],
    };
  }

  if (/\b(today|today's|daily)\b/.test(text) && /\b(recruit|activity|summary|summarise|summarize|happened)\b/.test(text)) {
    const today = todaySnapshot();
    return {
      reply: `Today’s recruitment activity:\n• ${today.jobs.today} new vacancies discovered (${today.jobs.total} total, ${today.jobs.analysed} analysed, ${today.jobs.strong} strong)\n• ${today.apps.awaiting} application package(s) needing your attention\n• ${today.apps.submitted_today} confirmed submission(s) today\n• ${today.apps.interviews} interview invitation(s) recorded\n• ${today.tasks.completed_today} task(s) completed, ${today.tasks.failed_today} failed\n• ${today.messages} recruiter message(s) stored\nAll figures are read directly from SQLite.`,
      taskIds,
    };
  }

  if (/\bwhat should i do next\b|\bnext step\b|\bwhat now\b/.test(text)) {
    const paused = agentSnapshot().filter((a) => a.status === "paused");
    const awaiting = one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status = 'awaiting_approval'")?.c ?? 0;
    const failed = one<{ agent_key: string; title: string; error: string | null }>(
      "SELECT agent_key, title, error FROM tasks WHERE status = 'failed' AND COALESCE(error_class, '') != 'blocked' ORDER BY created_at DESC LIMIT 1",
    );
    const pausedWorkflow = latestPausedWorkflow(workflowActor(userId));
    const newJobs = one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE match_score IS NULL")?.c ?? 0;
    const totalJobs = one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs")?.c ?? 0;
    const next = paused.length
      ? `Resume the ${paused.length} paused agent(s) first, then start a workflow.`        : failed
        ? `Review the failed ${agentIdentity(failed.agent_key).shortName} task (“${failed.title}”): ${failed.error ?? "no error recorded"}.`
        : pausedWorkflow
          ? `Resume the paused workflow “${pausedWorkflow.label}” or start a fresh run now that the agents are available.`
        : awaiting
          ? `Review ${awaiting} application(s) that stopped for a legitimate human step.`
          : newJobs
            ? `${newJobs} vacancy(ies) still need analysis. Run “Analyse unanalysed vacancies”.`
            : totalJobs === 0
              ? "Start a job search to pull vacancies from the real Arbeitnow source."
              : "Choose a vacancy, review its evidence, and generate a tailored package if the match is appropriate.";
    return { reply: next, taskIds };
  }

  if (/\b(why|which|what|when|did|was)\b.*\b(recruitment|run|quota|provider|fallback|pending|waiting|retry|gmail|email|notification|daily report)\b/.test(text)) {
    const snapshot = await getOperationalSnapshot();
    const direct = answerFromOperations(message, snapshot);
    if (direct) return { reply: direct, taskIds, agentKeys: ["coordinator"] };
  }

  if (/\bwhy\b.*\b(fail|failed|failure|error)\b/.test(text) || /\b(task|workflow)\b.*\bfail/.test(text)) {
    const failed = one<{ agent_key: string; title: string; error: string | null; created_at: string }>(
      "SELECT agent_key, title, error, created_at FROM tasks WHERE status = 'failed' AND COALESCE(error_class, '') != 'blocked' ORDER BY created_at DESC LIMIT 1",
    );
    if (!failed) return { reply: "There are no failed tasks recorded. The latest workflow does not have a failure to explain.", taskIds };
    return {
      reply: `The latest failed task was “${failed.title}” for ${agentIdentity(failed.agent_key).shortName}.\nRecorded error: ${failed.error ?? "No error message was stored."}\nNothing was retried automatically, and no success was recorded for that task.`,
      taskIds,
      agentKeys: [failed.agent_key],
    };
  }

  const toggleAgent = resolveAgent(text);
  if (/\b(pause|resume|unpause)\b/.test(text) && toggleAgent && !/\ball\b/.test(text)) {
    const paused = /\b(pause|stop)\b/.test(text);
    const changed = setAgentPaused(toggleAgent, paused);
    return {
      reply: changed
        ? `${agentIdentity(toggleAgent).name} is now ${paused ? "paused" : "idle and available"}. Its task and workflow history were preserved.`
        : `${agentIdentity(toggleAgent).name} cannot be ${paused ? "paused" : "resumed"} because it is disabled.`,
      taskIds,
      agentKeys: [toggleAgent],
    };
  }

  if (/\b(pause|stop)\b.*\b(agent|agents|workflow|workflows|everything|all)\b/.test(text) || text === "pause") {
    const count = pauseAllAgents(true);
    return { reply: `Paused ${count} enabled agent(s). No new work will be assigned until you resume them. Existing history is intact.`, taskIds, agentKeys: taskAgentKeys() };
  }
  if (/\b(resume|unpause|restart)\b.*\b(agent|agents|research|job search|workflow)\b/.test(text) || text === "resume") {
    const count = pauseAllAgents(false);
    return { reply: `Resumed ${count} enabled agent(s). All are Idle now; run a workflow to begin executing.`, taskIds, agentKeys: taskAgentKeys() };
  }

  if (/\b(clear|delete|purge)\b.*\bexpired\b/.test(text)) {
    return {
      reply: "This permanently deletes expired tailored documents and cover letters. Pinned files and packages awaiting submission are preserved. Reply “yes” to confirm or “no” to cancel.",
      taskIds,
      pendingAction: "cleanup_expired",
    };
  }

  if (/\b(german|deutsch)\b/.test(text) && /\b(no|not|do not|don't|avoid|exclude)\b/.test(text)) {
    const profile = getProfileData();
    const preferences = { ...profile.preferences, german_required: "avoid" };
    run("UPDATE profiles SET preferences = ?, updated_at = ? WHERE id = 1", [JSON.stringify(preferences), nowIso()]);
    return { reply: "Noted. Roles that require German are now flagged as weak matches rather than auto-rejected, so you can still review them.", taskIds };
  }

  const prioritise = text.match(/prioriti[sz]e\s+(.+)/);
  if (prioritise) {
    const places = prioritise[1]
      .replace(/\band\b/g, ",")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1));
    const profile = getProfileData();
    const merged = [...places, ...(profile.preferences.locations ?? []).filter((l) => !places.some((p) => p.toLowerCase() === l.toLowerCase()))];
    run("UPDATE profiles SET preferences = ?, updated_at = ? WHERE id = 1", [
      JSON.stringify({ ...profile.preferences, locations: merged }),
      nowIso(),
    ]);
    return { reply: `Search preferences updated. Priority locations: ${merged.slice(0, 8).join(", ")}.`, taskIds };
  }

  if (/\b(remote only|fully remote|hybrid|on-site only|onsite only)\b/.test(text) && /\b(prefer|set|update|want|only)\b/.test(text)) {
    const profile = getProfileData();
    const remotePreference = /\b(remote only|fully remote)\b/.test(text) ? "remote_only" : /\b(hybrid)\b/.test(text) ? "hybrid_or_remote" : "onsite";
    run("UPDATE profiles SET preferences = ?, updated_at = ? WHERE id = 1", [
      JSON.stringify({ ...profile.preferences, remote_preference: remotePreference }),
      nowIso(),
    ]);
    return { reply: `Work-mode preference updated to ${remotePreference.replace(/_/g, " ")}.`, taskIds };
  }

  const salaryPreference = text.match(/\bminimum salary\b.*?(chf\s*)?([\d'’,.]+)/);
  if (salaryPreference) {
    const value = Number(salaryPreference[2].replace(/[^\d]/g, ""));
    if (value > 0) {
      const profile = getProfileData();
      run("UPDATE profiles SET preferences = ?, updated_at = ? WHERE id = 1", [
        JSON.stringify({ ...profile.preferences, min_salary: value }),
        nowIso(),
      ]);
      return { reply: `Minimum salary preference updated to CHF ${value.toLocaleString("en-CH")}.`, taskIds };
    }
  }

  const generate = text.match(/(?:generate|create|prepare|make)\b.*\b(?:cv|documents?|package|cover letter)\b(?:\s+(?:for|at)\s+(.+))?/);
  if (generate) {
    const target = generate[1]?.replace(/[?.]$/, "").trim();
    const jobs = target
      ? all<{ id: string; title: string; company: string }>(
          "SELECT id, title, company FROM jobs WHERE lower(company) LIKE ? OR lower(title) LIKE ? ORDER BY discovered_at DESC LIMIT 5",
          [`%${target}%`, `%${target}%`],
        )
      : all<{ id: string; title: string; company: string }>(
          "SELECT id, title, company FROM jobs WHERE match_flag IN ('strong','possible') ORDER BY match_score DESC LIMIT 3",
        );
    if (jobs.length === 0) {
      return { reply: `I could not find a stored vacancy matching${target ? ` “${target}”` : " a strong match"}. Try the exact company name or run a search first.`, taskIds };
    }
    const job = jobs[0];
    const outcome = await generateApplicationPackage(userId, job.id);
    return {
      reply: outcome.ok
        ? `Documents prepared for ${job.title} at ${job.company}. ATS self-check ${outcome.atsScore}/100.${outcome.warnings.length ? ` Warnings: ${outcome.warnings.slice(0, 2).join(" ")}` : ""} The package is ready for the independent readiness check; eligible applications are submitted automatically without per-application approval.`
        : `I could not prepare documents: ${outcome.message}`,
      taskIds: outcome.applicationId ? [outcome.applicationId] : taskIds,
      agentKeys: ["cv", "ats", "cover", "application"],
    };
  }

  if (/\banaly[sz]e\b/.test(text) && /\b(jobs?|vacanc|backlog|pending)\b/.test(text)) {
    const target = text.match(/\banaly[sz]e\s+(?:the\s+)?(.+?)\s+(?:vacancy|job|role)\b/)?.[1]?.trim();
    if (target && !/^(unanalysed|pending|backlog|all)$/.test(target)) {
      const job = one<{ id: string; title: string; company: string }>(
        "SELECT id, title, company FROM jobs WHERE lower(company) LIKE ? OR lower(title) LIKE ? ORDER BY discovered_at DESC LIMIT 1",
        [`%${target}%`, `%${target}%`],
      );
      if (!job) return { reply: `No stored vacancy matches “${target}”.`, taskIds };
      const analysis = analyseSingleJob(job.id);
      return {
        reply: analysis
          ? `${job.title} at ${job.company} scored ${analysis.score}% (${analysis.flag}). ${analysis.recommendation} The evidence is stored on the vacancy.`
          : "The vacancy could not be analysed.",
        taskIds,
        agentKeys: ["analysis"],
      };
    }
    const count = analysePendingJobs();
    return { reply: `Analysed ${count} unanalysed vacanc${count === 1 ? "y" : "ies"} against your verified profile. Match evidence is now available in Job discovery.`, taskIds, agentKeys: ["analysis"] };
  }

  if (/\b(applications?)\b/.test(text) && /\b(this week|last week|weekly)\b/.test(text)) {
    const row = one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE submitted_at >= date('now','-7 days')");
    const total = one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE submitted_at IS NOT NULL");
    return { reply: `You have submitted ${row?.c ?? 0} application(s) in the last 7 days (${total?.c ?? 0} recorded in total). Only confirmed submissions are counted.`, taskIds };
  }

  if (/\b(review|show|list)\b.*\b(packages?|awaiting approval)\b/.test(text)) {
    const rows = all<{ id: string; title: string; company: string; status: string; last_update: string }>(
      `SELECT a.id, j.title, j.company, a.status, a.last_update FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE a.status = 'awaiting_approval' ORDER BY a.last_update DESC LIMIT 12`,
    );
    return {
      reply: rows.length
        ? `${rows.length} package(s) awaiting approval:\n${rows.map((r) => `• ${r.title} — ${r.company} · updated ${r.last_update.slice(0, 10)}`).join("\n")}`
        : "No application packages are awaiting approval. Nothing has been submitted automatically.",
      taskIds,
      agentKeys: ["application"],
    };
  }

  if (/\b(last|recent|show|list)\b.*\b(\d+)?\s*applications?\b/.test(text) || /\bshow\b.*\bapplications?\b/.test(text)) {
    const limitMatch = text.match(/(\d+)/);
    const limit = limitMatch ? Math.min(50, Number(limitMatch[1])) : 10;
    const rows = all<{ id: string; status: string; last_update: string; title: string; company: string }>(
      `SELECT a.id, a.status, a.last_update, j.title, j.company FROM applications a JOIN jobs j ON j.id = a.job_id
       ORDER BY a.last_update DESC LIMIT ?`,
      [limit],
    );
    if (rows.length === 0) return { reply: "There are no application records yet. Generate a package for a vacancy to create one.", taskIds };
    return {
      reply: `Your ${rows.length} most recent application(s):\n${rows
        .map((r) => `• ${r.title} — ${r.company} · ${statusLabel(r.status)} · updated ${r.last_update.slice(0, 10)}`)
        .join("\n")}`,
      taskIds,
    };
  }

  if (/\b(recruiter|email|inbox)\b.*\b(messages?|correspondence|replies)\b/.test(text)) {
    const rows = all<{ subject: string; sender: string | null; category: string; received_at: string | null; application_id: string | null }>(
      `SELECT subject, sender, category, received_at, application_id FROM email_messages
       WHERE category IN ('interview_invitation','rejection','recruiter_question','acknowledgement')
       ORDER BY COALESCE(received_at, created_at) DESC LIMIT 10`,
    );
    const unrelated = one<{ c: number }>("SELECT COUNT(*) AS c FROM email_messages WHERE category IN ('unrelated','unclassified')")?.c ?? 0;
    return {
      reply: rows.length
        ? `${rows.length} recent recruiter message(s):\n${rows.map((m) => `• ${m.subject} — ${m.sender ?? "unknown sender"} · ${m.category.replace(/_/g, " ")}${m.application_id ? " · matched" : ""}`).join("\n")}`
        : `No recruiter-related messages are categorised. ${unrelated ? `${unrelated} unrelated marketing or notification message(s) are excluded.` : "Connect Gmail in Inbox and run a sync; I will not invent correspondence."}`,
      taskIds,
      agentKeys: ["email"],
    };
  }

  if (/\b(jobs?|vacancies|vacancy)\b/.test(text) && /\b(above|over|higher than|greater than)\b/.test(text)) {
    const threshold = Number(text.match(/(\d{1,3})\s*%?/)?.[1] ?? 80);
    const rows = all<{ id: string; title: string; company: string; match_score: number }>(
      "SELECT id, title, company, match_score FROM jobs WHERE match_score >= ? ORDER BY match_score DESC LIMIT 15",
      [threshold],
    );
    return {
      reply: rows.length
        ? `${rows.length} vacanc${rows.length === 1 ? "y" : "ies"} at or above ${threshold}%:\n${rows.map((r) => `• ${r.title} — ${r.company} (${r.match_score}%)`).join("\n")}`
        : `No vacancies currently score ${threshold}% or above. The strongest match is ${one<{ s: number }>("SELECT MAX(match_score) AS s FROM jobs")?.s ?? 0}%.`,
      taskIds,
    };
  }

  if (/\b(list|show|display)\b.*\b(jobs?|vacancies|vacancy)\b/.test(text) && !/\b(find|search|discover)\b/.test(text)) {
    const rows = all<{ id: string; title: string; company: string; location: string | null; match_score: number | null; match_flag: string | null }>(
      "SELECT id, title, company, location, match_score, match_flag FROM jobs ORDER BY discovered_at DESC LIMIT 12",
    );
    return {
      reply: rows.length
        ? `${rows.length} stored vacancy${rows.length === 1 ? "" : "ies"}:\n${rows.map((r) => `• ${r.title} — ${r.company}${r.location ? `, ${r.location}` : ""}${r.match_score !== null ? ` · ${r.match_score}% (${r.match_flag})` : " · not analysed"}`).join("\n")}`
        : "There are no stored vacancies. Run a research pass; zero is displayed honestly when the source returns nothing usable.",
      taskIds,
    };
  }

  if (/\b(?:daily|weekly)\s+report\b/.test(text) || text === "report") {
    const since = new Date(Date.now() - 86400_000).toISOString();
    const discovered = one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE discovered_at >= ?", [since])?.c ?? 0;
    const strong = one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE match_flag = 'strong'")?.c ?? 0;
    const waiting = one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status = 'awaiting_approval'")?.c ?? 0;
    const submitted = one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE submitted_at >= ?", [since])?.c ?? 0;
    const interviews = one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status = 'interview_invited'")?.c ?? 0;
    return {
      reply: `Report — ${new Date().toLocaleDateString("en-GB")}\n• ${discovered} vacancies discovered in the last 24 hours\n• ${strong} strong matches on file\n• ${waiting} application(s) awaiting approval\n• ${submitted} submitted in the last 24 hours\n• ${interviews} interview invitation(s) recorded\nAll figures read directly from the database.`,
      taskIds,
    };
  }

  if (/\bwhy\b.*\b(rejected|weak|not suitable)\b/.test(text)) {
    const rows = all<{ title: string; company: string; match_score: number; analysis: string | null }>(
      "SELECT title, company, match_score, analysis FROM jobs WHERE match_flag IN ('weak','not_suitable') ORDER BY match_score ASC LIMIT 3",
    );
    if (!rows.length) return { reply: "No vacancy has been flagged weak or unsuitable yet.", taskIds };
    return {
      reply: rows
        .map((r) => {
          const reasons = r.analysis ? (JSON.parse(r.analysis).concerns ?? []) : [];
          return `${r.title} at ${r.company} (${r.match_score}%): ${reasons.length ? reasons.join(" ") : "No specific concerns recorded."}`;
        })
        .join("\n\n"),
      taskIds,
    };
  }

  const discoveryAction =
    /^(?:please\s+)?(?:find|search|discover|look for)\b/.test(text) ||
    /\b(?:can|could|would|please)\s+you\s+(?:find|search|discover|look for)\b/.test(text) ||
    /\b(?:run|start|trigger)\s+(?:a\s+)?(?:job\s+)?search\b/.test(text);
  if (discoveryAction) {
    const requested = Number(text.match(/(\d{1,3})\s*(?:jobs|vacanc)/)?.[1] ?? 20);
    const pages = Math.min(5, Math.max(1, Math.ceil(requested / 40)));
    const outcome = await runDiscovery(userId, pages);
    if (outcome.status !== "completed") return { reply: outcome.summary, taskIds };
    const strong = all<{ title: string; company: string; match_score: number }>(
      "SELECT title, company, match_score FROM jobs WHERE match_flag = 'strong' ORDER BY match_score DESC LIMIT 5",
    );
    return {
      reply: `${outcome.summary}${outcome.details.length ? `\n${outcome.details.map((d) => `• ${d}`).join("\n")}` : ""}${
        strong.length ? `\nStrong matches:\n${strong.map((s) => `• ${s.title} — ${s.company} (${s.match_score}%)`).join("\n")}` : ""
      }`,
      taskIds,
      agentKeys: ["research", "analysis"],
    };
  }

  const snapshot = await getOperationalSnapshot();
  const operational = answerFromOperations(message, snapshot);
  if (operational) return { reply: operational, taskIds, agentKeys: ["coordinator"] };
  return { reply: await conversationalReply(userId, message, snapshot, options.sessionId, options.onDelta), taskIds, agentKeys: ["coordinator"] };
}
