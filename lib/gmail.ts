import crypto from "node:crypto";
import { all, nowIso, one, run } from "./db";
import { setSetting } from "./settings";
import { randomId } from "./security";
import { notify } from "./notify";
import { GMAIL_IDENTITY_SCOPES, REQUIRED_GMAIL_SCOPES, gmailApiError, missingGrantedScopes, parseGmailProfile } from "./gmail-profile";

/**
 * Gmail OAuth and mailbox integration.
 * Tokens are encrypted at rest with AES-256-GCM derived from APP_SECRET_KEY.
 * Nothing is ever sent without an explicit approval action; this module only
 * creates drafts until `sendApprovedDraft` is called by a user action.
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

export async function syncInbox(limit = 20) {
  const account = one<GmailAccount>("SELECT * FROM gmail_accounts WHERE id = 1");
  if (!account) throw new Error("Gmail is not connected.");
  const list = await gmailFetch<{ messages?: Array<{ id: string }> }>(
    `/messages?maxResults=${Math.min(50, limit)}&q=${encodeURIComponent("in:inbox newer_than:120d")}`,
  );
  let inserted = 0;
  let matched = 0;
  let drafts = 0;
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
      run(
        `INSERT INTO email_messages (id, gmail_id, thread_id, application_id, sender, subject, snippet, category, body_text, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `mail_${randomId()}`,
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
  run("UPDATE gmail_accounts SET last_sync_at = ? WHERE id = 1", [nowIso()]);
  return { inserted, matched, drafts, scanned: list.messages?.length ?? 0 };
}

export function inboxMessages(limit = 40) {
  return all<{
    id: string;
    sender: string | null;
    subject: string;
    snippet: string;
    category: string;
    application_id: string | null;
    draft_id: string | null;
    draft_body: string | null;
    draft_status: string;
    received_at: string | null;
  }>(
    `SELECT id, sender, subject, snippet, category, application_id, draft_id, draft_body, draft_status, received_at
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
  run("DELETE FROM gmail_accounts WHERE id = 1");
  setSetting("email", { provider: "gmail", connected: false, sender: "", account: "" });
}
