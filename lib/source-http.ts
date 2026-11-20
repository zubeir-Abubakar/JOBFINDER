/**
 * Shared HTTP policy for public job sources.
 *
 * The policy is deliberately bounded: only transport failures, timeouts, 408,
 * 425, 429 and 5xx responses are retried. Authentication failures and other
 * permanent client errors stop immediately. A Retry-After longer than the
 * retry window is respected by not retrying early.
 */

import { assertPublicHttpUrl } from "./outbound-url";
import { readLimitedText, safeFetch } from "./safe-http";

export type SourceErrorCategory =
  | "network"
  | "timeout"
  | "rate_limited"
  | "authentication"
  | "http"
  | "parse"
  | "unknown";

export type SourceAttemptDiagnostic = {
  attempt: number;
  durationMs: number;
  statusCode: number | null;
  errorCategory: SourceErrorCategory | null;
  retryDecision: "success" | "retry" | "stop";
  retryAfterMs: number | null;
};

export type SourceRequestResult<T> = {
  ok: boolean;
  data: T | null;
  error: string | null;
  errorCategory: SourceErrorCategory | null;
  statusCode: number | null;
  attempts: number;
  durationMs: number;
  diagnostics: SourceAttemptDiagnostic[];
};

export type SourceRequestOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetryAfterMs?: number;
  maxResponseBytes?: number;
  label?: string;
  /** Test seam only. Production uses the DNS-pinned safeFetch transport. */
  transport?: (url: string, init?: RequestInit) => Promise<Response>;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function retryBaseMs(options: SourceRequestOptions): number {
  // Tests can make the bounded delay deterministic without changing production
  // behaviour. The environment value is timing only and contains no credentials.
  return boundedInt(
    options.baseDelayMs ?? process.env.RECRUITMENT_HTTP_RETRY_BASE_MS ?? DEFAULT_BASE_DELAY_MS,
    DEFAULT_BASE_DELAY_MS,
    0,
    5_000,
  );
}

function categoryForStatus(status: number): SourceErrorCategory | null {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "http";
  if (status >= 400) return "http";
  return null;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMs(headers: Headers): number | null {
  const value = headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - Date.now());
}

function backoffMs(attempt: number, options: SourceRequestOptions): number {
  const base = retryBaseMs(options);
  const max = boundedInt(options.maxDelayMs, DEFAULT_MAX_DELAY_MS, 0, 60_000);
  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  // Bounded jitter avoids a synchronised retry burst across boards.
  return Math.round(Math.min(max, exponential * (0.8 + Math.random() * 0.4)));
}

function classifyTransportError(error: unknown): SourceErrorCategory {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "timeout";
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timed?\s*out|timeout/i.test(message)) return "timeout";
  return "network";
}

function conciseError(label: string, category: SourceErrorCategory, status: number | null): string {
  switch (category) {
    case "authentication":
      return `${label} rejected the request (HTTP ${status ?? "unknown"}); authentication is required.`;
    case "rate_limited":
      return `${label} rate-limited the request (HTTP 429).`;
    case "timeout":
      return `${label} timed out.`;
    case "network":
      return `${label} could not be reached (network failure).`;
    case "parse":
      return `${label} returned an invalid response.`;
    case "http":
      return `${label} responded HTTP ${status ?? "error"}.`;
    default:
      return `${label} could not be read.`;
  }
}

async function request<T>(
  url: string,
  options: SourceRequestOptions,
  parse: (text: string) => T,
): Promise<SourceRequestResult<T>> {
  try {
    assertPublicHttpUrl(url);
  } catch (error) {
    return {
      ok: false,
      data: null,
      error: error instanceof Error ? error.message : "The source URL is not an allowed public address.",
      errorCategory: "network",
      statusCode: null,
      attempts: 0,
      durationMs: 0,
      diagnostics: [],
    };
  }
  const started = Date.now();
  const maxAttempts = boundedInt(options.attempts, DEFAULT_ATTEMPTS, 1, 5);
  const timeoutMs = boundedInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 10, 60_000);
  const maxRetryAfter = boundedInt(options.maxRetryAfterMs, DEFAULT_MAX_RETRY_AFTER_MS, 0, 60_000);
  // 12 MB covers the largest known public board pages while remaining a hard
  // bounded read. Callers that need a larger allowance must make that explicit.
  const maxResponseBytes = boundedInt(options.maxResponseBytes, 4 * 1024 * 1024, 1_024, 12 * 1024 * 1024);
  const label = options.label ?? "Job source";
  // Production always uses the DNS-pinned transport. Local development and
  // fixtures may use the platform fetch so existing integration servers and
  // tests keep their normal network semantics; ATW_SAFE_OUTBOUND forces the
  // hardened path outside production as well.
  const transport =
    options.transport ??
    (process.env.NODE_ENV === "production" || process.env.ATW_SAFE_OUTBOUND === "true" ? safeFetch : fetch);
  const diagnostics: SourceAttemptDiagnostic[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStarted = Date.now();
    try {
      const response = await transport(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "AT-AI-Workforce/2.4 (personal job search)",
          ...options.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      const durationMs = Date.now() - attemptStarted;
      if (!response.ok) {
        const category = categoryForStatus(response.status) ?? "http";
        const retryable = isRetryableStatus(response.status);
        const requestedDelay = retryAfterMs(response.headers);
        const canWait = requestedDelay === null || requestedDelay <= maxRetryAfter;
        const willRetry = retryable && canWait && attempt < maxAttempts;
        diagnostics.push({
          attempt,
          durationMs,
          statusCode: response.status,
          errorCategory: category,
          retryDecision: willRetry ? "retry" : "stop",
          retryAfterMs: requestedDelay,
        });
        if (willRetry) {
          const delay = requestedDelay ?? backoffMs(attempt, options);
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        return {
          ok: false,
          data: null,
          error: conciseError(label, category, response.status),
          errorCategory: category,
          statusCode: response.status,
          attempts: attempt,
          durationMs: Date.now() - started,
          diagnostics,
        };
      }

      try {
        const text = await readLimitedText(response, maxResponseBytes);
        const data = parse(text);
        diagnostics.push({
          attempt,
          durationMs: Date.now() - attemptStarted,
          statusCode: response.status,
          errorCategory: null,
          retryDecision: "success",
          retryAfterMs: null,
        });
        return {
          ok: true,
          data,
          error: null,
          errorCategory: null,
          statusCode: response.status,
          attempts: attempt,
          durationMs: Date.now() - started,
          diagnostics,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const sizeLimited = /size limit/i.test(message);
        diagnostics.push({
          attempt,
          durationMs: Date.now() - attemptStarted,
          statusCode: response.status,
          errorCategory: "parse",
          retryDecision: "stop",
          retryAfterMs: null,
        });
        return {
          ok: false,
          data: null,
          error: sizeLimited
            ? `${label} exceeded the configured response-size safety limit (${Math.round(maxResponseBytes / 1024 / 1024)} MB).`
            : conciseError(label, "parse", response.status),
          errorCategory: "parse",
          statusCode: response.status,
          attempts: attempt,
          durationMs: Date.now() - started,
          diagnostics,
        };
      }
    } catch (error) {
      const category = classifyTransportError(error);
      const willRetry = attempt < maxAttempts;
      diagnostics.push({
        attempt,
        durationMs: Date.now() - attemptStarted,
        statusCode: null,
        errorCategory: category,
        retryDecision: willRetry ? "retry" : "stop",
        retryAfterMs: null,
      });
      if (willRetry) {
        const delay = backoffMs(attempt, options);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return {
        ok: false,
        data: null,
        error: conciseError(label, category, null),
        errorCategory: category,
        statusCode: null,
        attempts: attempt,
        durationMs: Date.now() - started,
        diagnostics,
      };
    }
  }

  return {
    ok: false,
    data: null,
    error: conciseError(label, "unknown", null),
    errorCategory: "unknown",
    statusCode: null,
    attempts: maxAttempts,
    durationMs: Date.now() - started,
    diagnostics,
  };
}

export function requestJson<T>(url: string, options: SourceRequestOptions = {}): Promise<SourceRequestResult<T>> {
  return request<T>(url, { ...options, headers: { Accept: "application/json", ...options.headers } }, (text) => {
    return JSON.parse(text) as T;
  });
}

export function requestText(url: string, options: SourceRequestOptions = {}): Promise<SourceRequestResult<string>> {
  return request<string>(url, { ...options, headers: { Accept: "text/html", ...options.headers } }, (text) => text);
}
