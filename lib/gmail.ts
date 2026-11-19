import crypto from "node:crypto";
import { all, nowIso, one, run } from "./db";
import { setSetting } from "./settings";
import { randomId } from "./security";
import { notify } from "./notify";
import { audit } from "./audit";
import { GMAIL_IDENTITY_SCOPES, REQUIRED_GMAIL_SCOPES, GmailProfileError, gmailApiError, missingGrantedScopes, parseGmailProfile } from "./gmail-profile";
import { generateText, type AiCallSource } from "./providers";
import { enqueueAiJob, isQueueableAiError } from "./ai-queue";

/**
 * Gmail OAuth and mailbox integration.
 * Tokens are encrypted at rest with AES-256-GCM derived from APP_SECRET_KEY.
 * Workflows only create drafts until `sendApprovedDraft` is called by a user
 * action. The only other send path is the explicit Settings test message.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export type GmailAccount = {
  id: number;
  email: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string;
  scopes: string;
  connected_at: string;
  last_sync_at: string | null;
};

export type GmailTestStatus =
  | "accepted"
  | "unverified"
  | "missing_configuration"
  | "authentication_failed"
  | "permission_denied"
  | "invalid_recipient"
  | "api_error";

export type GmailTestResult = {
  status: GmailTestStatus;
  provider: "gmail";
  recipientMasked: string;
  messageId: string | null;
  threadId: string | null;
  delivery: "unverified" | null;
  detail: string;
  at: string;
};

/** Keep addresses out of logs and UI summaries without hiding the domain. */
export function maskEmail(value: string): string {
  const email = value.trim();
  const at = email.lastIndexOf("@");
  if (at < 1) return email ? "***" : "not configured";
  return `${email[0]}***${email.slice(at)}`;
}

function validRecipient(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function gmailConfig() {
  const scopes = new Set(
    (process.env.GMAIL_SCOPES ?? "https://www.googleapis.com/auth/gmail.readonly")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
  // Read, draft and approval-gated send access are always requested, together
  // with identity scopes so Google can confirm the connected mailbox. Existing
  // tokens may predate these scopes and must be reconnected rather than assumed
  // to have gained new permissions.
  for (const scope of [...REQUIRED_GMAIL_SCOPES, ...GMAIL_IDENTITY_SCOPES]) scopes.add(scope);
  const redirect = (process.env.GOOGLE_REDIRECT_URI ?? "").trim();
  return {
    enabled: (process.env.GMAIL_ENABLED ?? "false") === "true",
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: redirect && !/^SET_AFTER|^https?:\/\/localhost:3000\/?$/.test(redirect) ? redirect : null,
    scopes: [...scopes],
  };
}

export function gmailMissing(): string[] {
  const c = gmailConfig();
  const missing: string[] = [];
  if (!c.enabled) missing.push("GMAIL_ENABLED is not set to true.");
  if (!c.clientId) missing.push("GOOGLE_CLIENT_ID is missing.");
  if (!c.clientSecret) missing.push("GOOGLE_CLIENT_SECRET is missing.");
  if (!c.redirectUri) missing.push("GOOGLE_REDIRECT_URI is a placeholder. Set it to http://localhost:3000/api/gmail/oauth/callback in Google Cloud and .env.");
  if (!process.env.APP_SECRET_KEY) missing.push("APP_SECRET_KEY is missing, so tokens cannot be encrypted.");
  return missing;
}

export function oauthReady(): boolean {
  return gmailMissing().length === 0;
}

function encryptionKey(): Buffer {
  const secret = process.env.APP_SECRET_KEY;
  if (!secret) throw new Error("APP_SECRET_KEY is required to encrypt Gmail tokens.");
  return crypto.scryptSync(secret, "atw-gmail-token", 32);
}

function encrypt(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decrypt(value: string): string {
  const [version, iv, tag, data] = value.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Stored Gmail token format is invalid.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

export function stateToken(): string {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const signature = crypto.createHmac("sha256", process.env.APP_SECRET_KEY ?? "atw").update(nonce).digest("base64url");
  return `${nonce}.${signature}`;
}

export function verifyState(state: string | null): boolean {
  if (!state) return false;
  const [nonce, signature] = state.split(".");
  if (!nonce || !signature) return false;
  const expected = crypto.createHmac("sha256", process.env.APP_SECRET_KEY ?? "atw").update(nonce).digest("base64url");
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function authUrl(state: string): string {
  const c = gmailConfig();
  if (!c.redirectUri) throw new Error("GOOGLE_REDIRECT_URI is not configured.");
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: "code",
    scope: c.scopes.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function tokenRequest(body: Record<string, string>) {
  const c = gmailConfig();
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...body }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description ?? payload.error ?? `Google token endpoint returned ${response.status}`);
  }
  return payload;
}

export async function exchangeCode(code: string): Promise<void> {
  const c = gmailConfig();
  if (!c.redirectUri) throw new Error("GOOGLE_REDIRECT_URI is not configured.");
  const payload = await tokenRequest({ code, redirect_uri: c.redirectUri, grant_type: "authorization_code" });
  const token = payload.access_token as string;
  if (payload.scope) {
    const missing = missingGrantedScopes(payload.scope);
    if (missing.length > 0) {
      throw new Error(
        `Google did not grant every required Gmail permission (missing: ${missing.map((scope) => scope.split("/").pop()).join(", ")}). Reconnect Gmail and approve all requested permissions.`,
      );
    }
  }
  const profileResponse = await fetch(`${API}/profile`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  const profilePayload = await profileResponse.json().catch(() => ({}));
  // Gmail returns `emailAddress`; non-2xx responses are reported with their
  // actual cause instead of being treated as a profile without an address.
  const email = parseGmailProfile(profileResponse.status, profilePayload);
  const expiresAt = new Date(Date.now() + (payload.expires_in ?? 3600) * 1000).toISOString();
  const existing = one<GmailAccount>("SELECT * FROM gmail_accounts WHERE id = 1");
  const refresh = payload.refresh_token ?? existing?.refresh_token ?? "";
  if (!refresh) throw new Error("Google did not return a refresh token. Revoke the app and connect again.");
  run(
    `INSERT INTO gmail_accounts (id, email, access_token, refresh_token, expires_at, scopes, connected_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at, scopes = excluded.scopes, connected_at = excluded.connected_at`,
    [email, encrypt(token), encrypt(refresh), expiresAt, payload.scope ?? c.scopes.join(" "), nowIso()],
  );
  setSetting("email", { provider: "gmail", connected: true, sender: email, account: email });
  notify({ kind: "gmail_connected", subject: "Gmail connected", body: `${email} is connected. Drafts are created locally; sending requires your approval.` });
}

export function accountStatus() {
  const c = gmailConfig();
  const row = one<GmailAccount>("SELECT * FROM gmail_accounts WHERE id = 1");
  const missingScopes = row ? missingGrantedScopes(row.scopes) : [];
  return {
    enabled: c.enabled,
    oauthReady: oauthReady(),
    missing: gmailMissing(),
    redirectUri: c.redirectUri,
    scopes: c.scopes,
    requiredScopes: REQUIRED_GMAIL_SCOPES,
    connected: Boolean(row),
    email: row?.email ?? null,
    connectedAt: row?.connected_at ?? null,
    lastSyncAt: row?.last_sync_at ?? null,
    tokenEncrypted: Boolean(row?.access_token?.startsWith("v1.")),
    missingScopes,
    needsReconnect: Boolean(row) && missingScopes.length > 0,
  };
}

async function accessToken(): Promise<string> {
  const row = one<GmailAccount>("SELECT * FROM gmail_accounts WHERE id = 1");
  if (!row) throw new Error("Gmail is not connected.");
  if (new Date(row.expires_at).getTime() > Date.now() + 60_000) return decrypt(row.access_token);
  if (!row.refresh_token) throw new Error("Gmail refresh token is missing. Reconnect the account.");
  let payload: Awaited<ReturnType<typeof tokenRequest>>;
  try {
    payload = await tokenRequest({ refresh_token: decrypt(row.refresh_token), grant_type: "refresh_token" });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (/invalid_grant|expired|revoked|invalid refresh/i.test(message)) {
      throw new Error("Gmail authorisation expired or was revoked. Reconnect Gmail to continue.");
    }
    throw cause;
  }
  const expiresAt = new Date(Date.now() + (payload.expires_in ?? 3600) * 1000).toISOString();
  run("UPDATE gmail_accounts SET access_token = ?, expires_at = ? WHERE id = 1", [encrypt(payload.access_token as string), expiresAt]);
  return payload.access_token as string;
}

async function gmailFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken();
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!response.ok) throw gmailApiError(response.status, payload.error?.message);
  return payload;
}

function decode(data?: string): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

type GmailPayload = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPayload[];
  headers?: Array<{ name?: string; value?: string }>;
};
type GmailMessage = {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailPayload;
};

function header(payload: GmailPayload | undefined, name: string): string {
  return payload?.headers?.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "";
}

function bodyText(payload?: GmailPayload): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decode(payload.body.data);
  for (const part of payload.parts ?? []) {
    const text = bodyText(part);
    if (text) return text;
  }
  return payload.body?.data ? decode(payload.body.data) : "";
}

function classify(subject: string, body: string): string {
  const text = `${subject}\n${body}`.toLowerCase();
  if (/\b(interview|invitation to (meet|interview)|schedule a (call|meeting)|gespräch|entretien)\b/.test(text)) return "interview_invitation";
  if (/\b(unfortunately|not moving forward|unsuccessful|rejection|absage|nous ne donnerons pas suite)\b/.test(text)) return "rejection";
  if (/\b(question|clarif|additional document|missing document|rückfrage|précision)\b/.test(text)) return "recruiter_question";
  if (/\b(thank you for (your )?application|received your application|application (was )?received|bewerbung erhalten)\b/.test(text)) return "acknowledgement";
  return "unrelated";
}

function matchApplication(subject: string, body: string): { id: string; company: string; title: string } | null {
  const haystack = `${subject}\n${body}`.toLowerCase();
  const rows = all<{ id: string; company: string; title: string }>(
    `SELECT a.id, j.company, j.title FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.status NOT IN ('rejected') ORDER BY a.last_update DESC LIMIT 50`,
  );
  return rows.find((row) => row.company && row.company.length > 2 && haystack.includes(row.company.toLowerCase())) ?? null;
}

const AI_CATEGORIES = new Set([
  "interview_invitation",
  "rejection",
  "recruiter_question",
  "acknowledgement",
  "unrelated",
]);

/** Bounded per sync so a mailbox scan cannot turn into an unbounded AI run. */
const AI_CLASSIFY_LIMIT = 3;

type InboxContext = {
  workflowId?: string | null;
  taskId?: string | null;
  source?: Exclude<AiCallSource, "legacy">;
};

/**
 * Advisory classification. It never changes `email_messages.category` and is
 * never read by the status-update rules below; those remain deterministic.
 */
async function classifyWithAi(
  subject: string,
  body: string,
  messageRowId: string,
  gmailId: string,
  context: InboxContext,
): Promise<{ category: string | null; provider: string | null; model: string | null; queued?: boolean }> {
  try {
    const result = await generateText({
      agentKey: "email",
      workflowId: context.workflowId ?? null,
      taskId: context.taskId ?? null,
      source: context.source ?? (context.taskId ? "task" : "manual"),
      system:
        "You classify recruitment email. Reply with exactly one label and nothing else: interview_invitation, rejection, recruiter_question, acknowledgement, or unrelated. Never guess when the message is ambiguous; use unrelated.",
      prompt: `Subject: ${subject.slice(0, 300)}\n\nMessage: ${body.slice(0, 1200)}`,
      maxTokens: 8,
      temperature: 0,
    });
    const label = result.text.toLowerCase().replace(/[^a-z_]/g, "").trim();
    return {
      category: AI_CATEGORIES.has(label) ? label : null,
      provider: result.provider,
      model: result.model,
    };
  } catch (error) {
    // A rate-limited advisory classification is queued, never discarded. The
    // deterministic category and every application status change already ran.
    if (isQueueableAiError(error)) {
      try {
        enqueueAiJob({
          kind: "email_classification",
          dedupeKey: `email:${gmailId}`,
          agentKey: "email",
          workflowId: context.workflowId ?? null,
          taskId: context.taskId ?? null,
          source: context.source === "task" || context.taskId ? "task" : "manual",
          priority: 2,
          payload: {
            messageId: messageRowId,
            subject: subject.slice(0, 300),
            body: body.slice(0, 1200),
          },
        });
        return { category: null, provider: null, model: null, queued: true };
      } catch {
        // Fall through to the normal non-blocking failure below.
      }
    }
    // A failed advisory classification is recorded by the provider layer and
    // must not break the mailbox sync.
    return { category: null, provider: null, model: null };
  }
}

export async function syncInbox(limit = 20, context: InboxContext = {}) {
  const account = one<GmailAccount>("SELECT * FROM gmail_accounts WHERE id = 1");
  if (!account) throw new Error("Gmail is not connected.");
  const list = await gmailFetch<{ messages?: Array<{ id: string }> }>(
    `/messages?maxResults=${Math.min(50, limit)}&q=${encodeURIComponent("in:inbox newer_than:120d")}`,
  );
  let inserted = 0;
  let matched = 0;
  let drafts = 0;
  let aiChecked = 0;
  let aiClassified = 0;
  let aiQueued = 0;
  let aiFailed = 0;
  let aiProvider: string | null = null;
  let aiModel: string | null = null;
  const aiCandidates: Array<{ id: string; gmailId: string; subject: string; body: string }> = [];
  for (const item of list.messages ?? []) {
    const message = await gmailFetch<GmailMessage>(`/messages/${item.id}?format=full`);
    const sender = header(message.payload, "From");
    const subject = header(message.payload, "Subject") || "(no subject)";
    const body = bodyText(message.payload).slice(0, 12_000) || message.snippet || "";
    const category = classify(subject, body);
    const application = matchApplication(subject, body);
    const existing = one<{ id: string }>("SELECT id FROM email_messages WHERE gmail_id = ?", [message.id]);
    const receivedAt = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : nowIso();
    if (existing) {
      run("UPDATE email_messages SET category = ?, application_id = ?, snippet = ? WHERE id = ?", [
        category,
        application?.id ?? null,
        message.snippet ?? body.slice(0, 240),
        existing.id,
      ]);
    } else {
      const messageRowId = `mail_${randomId()}`;
      run(
        `INSERT INTO email_messages (id, gmail_id, thread_id, application_id, sender, subject, snippet, category, body_text, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          messageRowId,
          message.id,
          message.threadId ?? null,
          application?.id ?? null,
          sender,
          subject,
          message.snippet ?? body.slice(0, 240),
          category,
          body,
          receivedAt,
          nowIso(),
        ],
      );
      inserted += 1;
      // Classification is deferred until every deterministic status update has
      // been applied, so an AI timeout can never delay a status change.
      aiCandidates.push({ id: messageRowId, gmailId: message.id, subject, body });
    }
    if (application) {
      matched += 1;
      if (category === "interview_invitation") {
        run("UPDATE applications SET status = 'interview_invited', last_update = ? WHERE id = ?", [nowIso(), application.id]);
        notify({ kind: "interview", subject: `Interview invitation: ${application.title}`, body: `${application.company} replied by email. Review the message in the inbox.` });
      } else if (category === "rejection") {
        run("UPDATE applications SET status = 'rejected', last_update = ? WHERE id = ?", [nowIso(), application.id]);
        notify({ kind: "rejection", subject: `Rejection: ${application.title}`, body: `${application.company} sent a rejection. The application status was updated.` });
      } else if (category === "recruiter_question") {
        notify({ kind: "recruiter_question", subject: `Recruiter question: ${application.company}`, body: subject });
      }
    }
    if (category === "interview_invitation" && !one("SELECT id FROM email_messages WHERE gmail_id = ? AND draft_id IS NOT NULL", [message.id])) {
      drafts += 1;
    }
  }
  // Advisory review of new mail, capped per sync and run only after the
  // deterministic category has already driven every status update.
  for (const candidate of aiCandidates.slice(0, AI_CLASSIFY_LIMIT)) {
    aiChecked += 1;
    const advisory = await classifyWithAi(candidate.subject, candidate.body, candidate.id, candidate.gmailId, context);
    aiProvider = advisory.provider ?? aiProvider;
    aiModel = advisory.model ?? aiModel;
    if (advisory.category) {
      run("UPDATE email_messages SET ai_category = ?, ai_classified_at = ? WHERE id = ?", [
        advisory.category,
        nowIso(),
        candidate.id,
      ]);
      aiClassified += 1;
    } else if (advisory.queued) {
      aiQueued += 1;
    } else {
      aiFailed += 1;
    }
  }

  // The email task is marked AI-assisted only when an advisory call actually
  // ran inline. Queued work marks the same task when it completes.
  const aiExecuted = aiClassified + aiFailed;
  if (context.taskId && aiExecuted > 0) {
    run(
      "UPDATE tasks SET execution_mode = 'ai', ai_outcome = ?, provider = COALESCE(?, provider), model = COALESCE(?, model), attempts = attempts + ? WHERE id = ?",
      [aiClassified > 0 ? "ok" : "failed", aiProvider, aiModel, aiExecuted, context.taskId],
    );
  }
  run("UPDATE gmail_accounts SET last_sync_at = ? WHERE id = 1", [nowIso()]);
  return { inserted, matched, drafts, scanned: list.messages?.length ?? 0, aiChecked, aiClassified, aiQueued, aiFailed };
}

export function inboxMessages(limit = 40) {
  return all<{
    id: string;
    sender: string | null;
    subject: string;
    snippet: string;
    category: string;
    ai_category: string | null;
    application_id: string | null;
    draft_id: string | null;
    draft_body: string | null;
    draft_status: string;
    received_at: string | null;
  }>(
    `SELECT id, sender, subject, snippet, category, ai_category, application_id, draft_id, draft_body, draft_status, received_at
     FROM email_messages ORDER BY received_at DESC LIMIT ?`,
    [limit],
  );
}

function mimeEncode(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function draftEmail(to: string, subject: string, body: string) {
  const from = one<GmailAccount>("SELECT email FROM gmail_accounts WHERE id = 1")?.email ?? "";
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${mimeEncode(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    ...body.split("\n"),
  ].join("\r\n");
  return Buffer.from(message, "utf8").toString("base64url");
}

function sendFailure(recipient: string, status: GmailTestStatus, detail: string): GmailTestResult {
  return {
    provider: "gmail",
    recipientMasked: maskEmail(recipient),
    status,
    messageId: null,
    threadId: null,
    delivery: null,
    detail,
    at: nowIso(),
  };
}

/**
 * One Gmail send implementation used by the explicit test and the durable
 * notification outbox. Gmail's message id proves API acceptance, not inbox
 * delivery; the latter is never claimed by this application.
 */
export async function sendGmailEmail(to: string, subject: string, body: string): Promise<GmailTestResult> {
  const recipient = to.trim();
  if (!validRecipient(recipient)) return sendFailure(recipient, "invalid_recipient", "Enter a valid notification email address.");

  const missing = gmailMissing();
  if (missing.length > 0) return sendFailure(recipient, "missing_configuration", `Gmail is not ready: ${missing.join(" ")}`);

  const account = accountStatus();
  if (!account.connected) return sendFailure(recipient, "missing_configuration", "Gmail is not connected. Connect the mailbox from Admin → Email.");
  if (account.needsReconnect) {
    return sendFailure(
      recipient,
      "permission_denied",
      `Gmail is missing required permissions: ${account.missingScopes.map((scope) => scope.split("/").pop()).join(", ")}. Reconnect Gmail and approve read, draft and send access.`,
    );
  }

  try {
    const sent = await gmailFetch<{ id?: string; threadId?: string }>("/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw: draftEmail(recipient, subject, body) }),
    });
    if (!sent?.id) return sendFailure(recipient, "unverified", "Gmail returned a successful response without a message ID. Delivery cannot be confirmed.");
    return {
      provider: "gmail",
      recipientMasked: maskEmail(recipient),
      status: "accepted",
      messageId: sent.id,
      threadId: sent.threadId ?? null,
      delivery: "unverified",
      detail: "Gmail accepted the message. Delivery to the mailbox is not independently verified by the application.",
      at: nowIso(),
    };
  } catch (cause) {
    if (cause instanceof GmailProfileError) {
      if (cause.kind === "expired") return sendFailure(recipient, "authentication_failed", cause.message);
      if (cause.kind === "scope") return sendFailure(recipient, "permission_denied", cause.message);
      if (cause.kind === "api_disabled") return sendFailure(recipient, "missing_configuration", cause.message);
      return sendFailure(recipient, "api_error", cause.message);
    }
    const message = cause instanceof Error ? cause.message : "Gmail send failed.";
    if (/invalid_grant|expired|revoked|refresh token|authorisation|decrypt|unable to authenticate|stored gmail token/i.test(message)) {
      return sendFailure(recipient, "authentication_failed", message.slice(0, 500));
    }
    return sendFailure(recipient, "api_error", message.slice(0, 500));
  }
}

/** Verify the stored OAuth token against Gmail without sending a message. */
export async function verifyGmailAccess(): Promise<{ ok: boolean; email: string | null; detail: string }> {
  const missing = gmailMissing();
  if (missing.length > 0) return { ok: false, email: null, detail: missing.join(" ") };
  const account = accountStatus();
  if (!account.connected) return { ok: false, email: null, detail: "Gmail is not connected." };
  if (account.needsReconnect) return { ok: false, email: account.email, detail: "Gmail must be reconnected because required scopes are missing." };
  try {
    const profile = await gmailFetch<{ emailAddress?: string }>("/profile");
    if (!profile.emailAddress) return { ok: false, email: account.email, detail: "Gmail returned no mailbox identity." };
    return { ok: true, email: profile.emailAddress, detail: "Stored OAuth token refreshed and Gmail profile accepted it." };
  } catch (cause) {
    return { ok: false, email: account.email, detail: cause instanceof Error ? cause.message.slice(0, 500) : "Gmail authentication failed." };
  }
}

/**
 * Send one explicitly requested test message through the connected Gmail
 * account. Exactly one API send call is made.
 */
export async function sendGmailTestEmail(to: string): Promise<GmailTestResult> {
  const body = [
    "This is a test message from Towfiq AI Agents.",
    "",
    `Requested at ${new Date().toISOString()}.`,
    "If you received this, Gmail accepted the send request from the connected mailbox.",
    "The application can confirm API acceptance but cannot independently verify inbox delivery.",
  ].join("\n");
  return sendGmailEmail(to, "Towfiq AI Agents — Gmail test", body);
}

/** Persist and audit the result so the Settings card shows the last real outcome. */
export async function runGmailTestEmail(to: string, userId?: string | null): Promise<GmailTestResult> {
  const result = await sendGmailTestEmail(to);
  setSetting("email_test_last", result);
  audit({
    userId: userId ?? null,
    action: `email.test_${result.status}`,
    entity: "email",
    detail: [
      "provider=gmail",
      `recipient=${result.recipientMasked}`,
      `status=${result.status}`,
      `delivery=${result.delivery ?? "not-applicable"}`,
      `messageId=${result.messageId ?? "none"}`,
      result.detail,
    ]
      .join(" · ")
      .replace(/\s+/g, " ")
      .slice(0, 1000),
  });
  return result;
}

export async function createDraft(emailId: string, draftBody: string): Promise<void> {
  const message = one<{ id: string; sender: string | null; subject: string; body_text: string | null }>(
    "SELECT id, sender, subject, body_text FROM email_messages WHERE id = ?",
    [emailId],
  );
  if (!message) throw new Error("Email not found.");
  const to = (message.sender ?? "").match(/<([^>]+)>/)?.[1] ?? message.sender ?? "";
  const subject = /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`;
  const raw = draftEmail(to, subject, draftBody.slice(0, 6000));
  const created = await gmailFetch<{ id?: string }>("/drafts", { method: "POST", body: JSON.stringify({ message: { raw } }) });
  if (!created.id) throw new Error("Gmail did not return a draft id.");
  run("UPDATE email_messages SET draft_id = ?, draft_body = ?, draft_status = 'draft' WHERE id = ?", [created.id, draftBody, emailId]);
}

export async function sendApprovedDraft(emailId: string): Promise<void> {
  const row = one<{ id: string; draft_id: string | null; subject: string; application_id: string | null }>(
    "SELECT id, draft_id, subject, application_id FROM email_messages WHERE id = ?",
    [emailId],
  );
  if (!row?.draft_id) throw new Error("No Gmail draft exists for this message.");
  await gmailFetch(`/drafts/send`, { method: "POST", body: JSON.stringify({ id: row.draft_id }) });
  run("UPDATE email_messages SET draft_status = 'sent' WHERE id = ?", [emailId]);
  notify({ kind: "email_sent", subject: `Approved email sent: ${row.subject}`, body: "The Gmail draft was sent after explicit approval." });
}

export function disconnectGmail(): void {
  setSetting("email_test_last", null);
  run("DELETE FROM gmail_accounts WHERE id = 1");
  setSetting("email", { provider: "gmail", connected: false, sender: "", account: "" });
}
