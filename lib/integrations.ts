import { getSetting, setSetting } from "./settings";
import { safeFetch } from "./safe-http";

/**
 * Administrator-facing integration inventory.
 *
 * Adapter code existing is not the same as an integration being operational.
 * This module reports only what is configured (credential present), what was
 * last verified by a real connection test, and what remains missing. Secret
 * values are never returned to the page.
 */

export const INTEGRATION_KEYS = ["greenhouse", "lever", "ashby", "candidate_form", "http_form"] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

export type IntegrationCheckStatus = "success" | "failed" | "blocked" | "not_applicable";
export type IntegrationCheck = {
  status: IntegrationCheckStatus;
  checkedAt: string;
  detail: string;
};

export type IntegrationView = {
  key: IntegrationKey;
  name: string;
  kind: "ATS adapter" | "Employer form" | "Configured endpoint";
  connectionStatus: string;
  connectionTone: "good" | "warn" | "bad" | "neutral";
  credentials: Array<{ name: string; present: boolean; note: string }>;
  capabilities: string[];
  lastCheck: IntegrationCheck | null;
  lastSuccessAt: string | null;
  operational: boolean;
  operationalDetail: string;
  missing: string[];
  testable: boolean;
};

const ENV = {
  greenhouse: "GREENHOUSE_JOB_BOARD_API_KEY",
  lever: "LEVER_POSTINGS_API_KEY",
  ashby: "ASHBY_API_KEY",
} as const;

function credentialPresent(name: string): boolean {
  return Boolean((process.env[name] ?? "").trim());
}

function checks(): Partial<Record<IntegrationKey, IntegrationCheck>> {
  return getSetting<Partial<Record<IntegrationKey, IntegrationCheck>>>("integration_checks", {});
}

function checkFor(key: IntegrationKey): IntegrationCheck | null {
  const value = checks()[key];
  if (!value || typeof value !== "object" || typeof value.status !== "string") return null;
  return value;
}

function lastSuccess(key: IntegrationKey): string | null {
  const current = checkFor(key);
  return current?.status === "success" ? current.checkedAt : getSetting<string | null>(`integration_last_success_${key}`, null);
}

function atsView(key: "greenhouse" | "lever" | "ashby"): IntegrationView {
  const names: Record<typeof key, { name: string; capability: string }> = {
    greenhouse: {
      name: "Greenhouse",
      capability: "Employer-issued Job Board API key; POST application with CV and cover letter",
    },
    lever: {
      name: "Lever",
      capability: "Employer-issued postings key; POST application with CV and cover letter",
    },
    ashby: {
      name: "Ashby",
      capability: "Employer-issued candidatesWrite key; applicationForm.submit",
    },
  };
  const envName = ENV[key];
  const present = credentialPresent(envName);
  const current = checkFor(key);
  const successful = lastSuccess(key);
  const verified = current?.status === "success";
  const missing = present ? [] : [`${envName} is not set. Only the employer can issue this credential.`];
  const operational = present && verified;
  const connectionStatus = !present
    ? "Awaiting employer credential"
    : verified
      ? "Connection verified"
      : "Credential present — not verified";
  return {
    key,
    name: names[key].name,
    kind: "ATS adapter",
    connectionStatus,
    connectionTone: !present ? "bad" : verified ? "good" : "warn",
    credentials: [
      {
        name: envName,
        present,
        note: present ? "Set in the server environment; value is never displayed." : "Missing. Candidate cannot self-issue this credential.",
      },
    ],
    capabilities: [
      names[key].capability,
      "Employer reference required before a submission is counted",
      "Required custom questions are never invented",
    ],
    lastCheck: current,
    lastSuccessAt: successful,
    operational,
    operationalDetail: operational
      ? "Credential and connection test passed. A live submission still requires an open vacancy and every readiness, duplicate and policy gate."
      : !present
        ? "Not operational: the employer-issued credential is missing. Packages remain queued for the employer's hosted form."
        : "Not operational until a real connection test succeeds and a live application is verified.",
    missing,
    testable: present,
  };
}

function candidateFormView(): IntegrationView {
  const enabled = process.env.RECRUITMENT_CANDIDATE_FORMS !== "false";
  const current = checkFor("candidate_form");
  return {
    key: "candidate_form",
    name: "Candidate-facing application forms",
    kind: "Employer form",
    connectionStatus: enabled ? "Adapter enabled — per-vacancy validation" : "Adapter disabled",
    connectionTone: enabled ? "warn" : "bad",
    credentials: [
      {
        name: "No global credential",
        present: true,
        note: "Each employer form is read at submission time; CAPTCHA, MFA, login and payment stop automation.",
      },
    ],
    capabilities: [
      "Normal candidate forms only",
      "Verified-profile answers and uploaded CV/cover letter",
      "Unknown consequential questions queue for human input",
    ],
    lastCheck: current,
    lastSuccessAt: current?.status === "success" ? current.checkedAt : null,
    operational: false,
    operationalDetail: enabled
      ? "Implemented and mock-tested only. It is not marked operational until a permitted live form returns employer evidence."
      : "Disabled by RECRUITMENT_CANDIDATE_FORMS=false.",
    missing: enabled ? ["No live end-to-end submission has been verified in this deployment."] : ["The candidate-form adapter is disabled."],
    testable: false,
  };
}

function httpFormView(): IntegrationView {
  const endpoint = (process.env.RECRUITMENT_SUBMISSION_ENDPOINT ?? "").trim();
  const current = checkFor("http_form");
  const operational = Boolean(endpoint && current?.status === "success");
  return {
    key: "http_form",
    name: "Configured HTTP form endpoint",
    kind: "Configured endpoint",
    connectionStatus: !endpoint ? "Not configured" : current?.status === "success" ? "Endpoint verified" : "Endpoint configured — not verified",
    connectionTone: !endpoint ? "bad" : current?.status === "success" ? "good" : "warn",
    credentials: [
      {
        name: "RECRUITMENT_SUBMISSION_ENDPOINT",
        present: Boolean(endpoint),
        note: "Optional endpoint template. No value is displayed because it may contain private routing details.",
      },
    ],
    capabilities: [
      "POST CV, cover letter and verified profile fields",
      "Placeholders: {job_id}, {application_url}, {company}",
      "No endpoint is invented for an employer",
    ],
    lastCheck: current,
    lastSuccessAt: current?.status === "success" ? current.checkedAt : null,
    operational,
    operationalDetail: operational
      ? "Configured endpoint passed its controlled test. Live submission still requires every readiness and policy gate."
      : endpoint
        ? "Configured but not verified. A controlled POST is required before it can be considered operational."
        : "No generic endpoint is configured. This is intentional unless an authorised endpoint exists.",
    missing: endpoint ? ["No successful controlled connection test recorded."] : ["RECRUITMENT_SUBMISSION_ENDPOINT is empty."],
    testable: false,
  };
}

export function integrationInventory(): { integrations: IntegrationView[]; automaticSubmissionOperational: boolean; reasons: string[] } {
  const integrations = [atsView("greenhouse"), atsView("lever"), atsView("ashby"), candidateFormView(), httpFormView()];
  const operational = integrations.filter((item) => item.operational);
  const automaticSubmissionOperational = operational.length > 0;
  return {
    integrations,
    automaticSubmissionOperational,
    reasons: automaticSubmissionOperational
      ? ["At least one adapter reports a verified connection. Per-vacancy eligibility and every readiness gate still apply."]
      : [
          "No ATS credential is configured.",
          "No generic endpoint is configured or verified.",
          "Candidate-facing forms are implemented and mock-tested but no live submission has been verified.",
          "Automatic submission therefore remains unavailable; packages are prepared and queued.",
        ],
  };
}

function shortDetail(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 400);
}

/** Safe connection tests only; no application or candidate data is sent. */
export async function testIntegrationConnection(key: IntegrationKey): Promise<IntegrationCheck> {
  const checkedAt = new Date().toISOString();
  if (key === "greenhouse" || key === "lever" || key === "ashby") {
    const envName = ENV[key];
    const credential = (process.env[envName] ?? "").trim();
    if (!credential) {
      return {
        status: "blocked",
        checkedAt,
        detail: `${envName} is missing. No connection was attempted and no request was sent.`,
      };
    }
    if (key === "greenhouse" || key === "lever") {
      return {
        status: "blocked",
        checkedAt,
        detail: `${envName} is present, but a live employer board/posting is required for a meaningful connection test. Nothing was sent.`,
      };
    }
    try {
      const response = await safeFetch("https://api.ashbyhq.com/jobPosting.list", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${credential}:`).toString("base64")}`,
          "Content-Type": "application/json",
          "User-Agent": "AT-AI-Workforce/2.3 (integration test)",
        },
        body: JSON.stringify({ limit: 1 }),
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
      });
      return response.ok
        ? { status: "success", checkedAt, detail: `Ashby accepted a read-only credential test (HTTP ${response.status}). No application was sent.` }
        : { status: "failed", checkedAt, detail: `Ashby rejected the credential test with HTTP ${response.status}. No application was sent.` };
    } catch (error) {
      return {
        status: "failed",
        checkedAt,
        detail: `Ashby could not be reached: ${shortDetail(error instanceof Error ? error.message : "unknown network error")}. No application was sent.`,
      };
    }
  }
  if (key === "candidate_form") {
    return {
      status: process.env.RECRUITMENT_CANDIDATE_FORMS === "false" ? "blocked" : "not_applicable",
      checkedAt,
      detail: process.env.RECRUITMENT_CANDIDATE_FORMS === "false"
        ? "Candidate-facing forms are disabled."
        : "There is no global form endpoint to test. Validation is per vacancy, so a mock result is not presented as a live connection.",
    };
  }
  return {
    status: (process.env.RECRUITMENT_SUBMISSION_ENDPOINT ?? "").trim() ? "not_applicable" : "blocked",
    checkedAt,
    detail: (process.env.RECRUITMENT_SUBMISSION_ENDPOINT ?? "").trim()
      ? "A template endpoint is configured, but a specific job and a controlled test are required. No request was sent."
      : "RECRUITMENT_SUBMISSION_ENDPOINT is empty.",
  };
}

export function recordIntegrationCheck(key: IntegrationKey, result: IntegrationCheck): void {
  const current = checks();
  setSetting("integration_checks", { ...current, [key]: result });
  if (result.status === "success") setSetting(`integration_last_success_${key}`, result.checkedAt);
}
