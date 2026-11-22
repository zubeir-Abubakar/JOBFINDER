/**
 * Audit explorer query builder. Filters are additive and never rewrite stored
 * rows; pagination is bounded and the full history stays in the database.
 */
export type AuditSeverity = "error" | "warning" | "info";

const ERROR_PATTERNS = [/failed/i, /error/i, /denied/i, /blocked/i, /breach/i];
const WARNING_PATTERNS = [/unverified/i, /unknown/i, /degraded/i, /unavailable/i, /timeout/i, /retry/i, /warning/i];

export function auditSeverity(action: string): AuditSeverity {
  if (ERROR_PATTERNS.some((pattern) => pattern.test(action))) return "error";
  if (WARNING_PATTERNS.some((pattern) => pattern.test(action))) return "warning";
  return "info";
}

export function auditCategory(action: string): string {
  const index = action.indexOf(".");
  return index > 0 ? action.slice(0, index) : action;
}

export type AuditQueryInput = {
  q?: string;
  category?: string;
  severity?: string;
  agentKey?: string;
  agentName?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

export type AuditQuery = {
  where: string;
  params: unknown[];
  page: number;
  pageSize: number;
  offset: number;
};

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 40;

export function buildAuditQuery(input: AuditQueryInput): AuditQuery {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const q = (input.q ?? "").trim();
  if (q) {
    clauses.push("(action LIKE ? OR detail LIKE ? OR actor LIKE ? OR entity_id LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (input.category) {
    clauses.push("action LIKE ?");
    params.push(`${input.category}.%`);
  }
  if (input.severity === "error") {
    clauses.push("(action LIKE '%failed%' OR action LIKE '%error%' OR action LIKE '%denied%' OR action LIKE '%blocked%')");
  } else if (input.severity === "warning") {
    clauses.push(
      "(action LIKE '%unverified%' OR action LIKE '%unknown%' OR action LIKE '%degraded%' OR action LIKE '%unavailable%' OR action LIKE '%timeout%' OR action LIKE '%retry%' OR action LIKE '%warning%')",
    );
  } else if (input.severity === "info") {
    clauses.push(
      "NOT (action LIKE '%failed%' OR action LIKE '%error%' OR action LIKE '%denied%' OR action LIKE '%blocked%' OR action LIKE '%unverified%' OR action LIKE '%unknown%' OR action LIKE '%degraded%' OR action LIKE '%unavailable%' OR action LIKE '%timeout%' OR action LIKE '%retry%' OR action LIKE '%warning%')",
    );
  }
  if (input.agentKey) {
    clauses.push("((entity = 'agent' AND entity_id = ?) OR detail LIKE ? OR actor LIKE ?)");
    const name = input.agentName ?? input.agentKey;
    params.push(input.agentKey, `%${name}%`, `%${name}%`);
  }
  if (input.from) {
    clauses.push("created_at >= ?");
    params.push(input.from);
  }
  if (input.to) {
    clauses.push("created_at <= ?");
    params.push(input.to);
  }
  const rawSize = Number(input.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = Number.isFinite(rawSize) ? Math.min(MAX_PAGE_SIZE, Math.max(10, Math.round(rawSize))) : DEFAULT_PAGE_SIZE;
  const rawPage = Number(input.page ?? 1);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.round(rawPage)) : 1;
  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}

/** Keeps existing filters when paginating without changing the audit rows. */
export function auditPageHref(params: Record<string, string | undefined>, page: number): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "page" || !value) continue;
    search.set(key, value);
  }
  search.set("page", String(page));
  return `/admin/audit?${search.toString()}`;
}
