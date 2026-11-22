import { hasVerifiedSubmissionEvidence, statusRequiresVerifiedSubmission } from "./application-status";

/**
 * The owner-facing Kanban is a presentation layer over the existing
 * `applications.status` values. It never invents a status and it never treats
 * a prepared document as a submission: a `submitted` row without both a
 * timestamp and an employer reference is surfaced under Needs attention.
 */
export type BoardColumnKey = "considering" | "to_apply" | "applied" | "needs_attention";

export const BOARD_COLUMNS: Array<{
  key: BoardColumnKey;
  label: string;
  hint: string;
  statuses: readonly string[];
}> = [
  {
    key: "considering",
    label: "Considering",
    hint: "Discovered, analysed or shortlisted",
    statuses: ["discovered", "analysing", "under_review", "qualified", "shortlisted", "rejected_below_threshold", "rejected_ineligible"],
  },
  {
    key: "to_apply",
    label: "To be applied",
    hint: "Documents in preparation or ready to send",
    statuses: [
      "documents_preparing",
      "preparing_documents",
      "quality_check",
      "quality_review_required",
      "ready_to_submit",
      "submitting",
      "awaiting_approval",
      "approval_required",
    ],
  },
  {
    key: "applied",
    label: "Applied",
    hint: "Employer-confirmed submissions and interview stages",
    statuses: ["submitted", "acknowledged", "interview", "interview_invited", "interview_completed", "offer_received"],
  },
  {
    key: "needs_attention",
    label: "Needs attention",
    hint: "Blocked, failed or unverified submissions",
    statuses: ["human_intervention_required", "submission_unverified", "submission_unknown", "submission_failed"],
  },
];

/** Closed records stay visible below the board; nothing is deleted or hidden. */
export const CLOSED_STATUSES = ["rejected", "rejected_by_employer", "withdrawn"] as const;

export type BoardRow = {
  status: string;
  submitted_at: string | null;
  confirmation: string | null;
};

export function boardColumnForStatus(status: string): BoardColumnKey | "closed" | null {
  const column = BOARD_COLUMNS.find((candidate) => candidate.statuses.includes(status));
  if (column) return column.key;
  if ((CLOSED_STATUSES as readonly string[]).includes(status)) return "closed";
  return null;
}

/**
 * The single owner-facing classification. Every post-submission status — not
 * only a bare `submitted` — requires verified employer evidence. A legacy
 * interview-stage record without that evidence is surfaced under Needs
 * attention rather than presented as an applied, employer-confirmed record.
 */
export function boardColumnForRow(row: BoardRow): BoardColumnKey | "closed" {
  if (statusRequiresVerifiedSubmission(row.status) && !hasVerifiedSubmissionEvidence(row)) return "needs_attention";
  return boardColumnForStatus(row.status) ?? "considering";
}

export function groupBoardRows<T extends BoardRow>(rows: T[]): Record<BoardColumnKey, T[]> {
  const grouped: Record<BoardColumnKey, T[]> = {
    considering: [],
    to_apply: [],
    applied: [],
    needs_attention: [],
  };
  for (const row of rows) {
    const column = boardColumnForRow(row);
    if (column !== "closed") grouped[column].push(row);
  }
  return grouped;
}

export function splitBoardRows<T extends BoardRow>(rows: T[]): { open: T[]; closed: T[] } {
  const open: T[] = [];
  const closed: T[] = [];
  for (const row of rows) {
    if (boardColumnForRow(row) === "closed") closed.push(row);
    else open.push(row);
  }
  return { open, closed };
}

export type BoardCounts = Record<BoardColumnKey | "closed", number> & { total: number };

/**
 * Counts are derived from the same rows the board renders, so a column header
 * can never disagree with the cards underneath it.
 */
export function boardCounts<T extends BoardRow>(rows: T[]): BoardCounts {
  const counts: BoardCounts = {
    considering: 0,
    to_apply: 0,
    applied: 0,
    needs_attention: 0,
    closed: 0,
    total: rows.length,
  };
  for (const row of rows) counts[boardColumnForRow(row)] += 1;
  return counts;
}

/**
 * Kanban drop destinations. `needs_attention` is deliberately absent: it is an
 * exception bucket set by the system, not a status a user can drag a card into.
 * Every target still passes through validateApplicationStatusTransition.
 */
export const BOARD_DROP_TARGETS: Partial<Record<BoardColumnKey, string>> = {
  considering: "under_review",
  to_apply: "documents_preparing",
  applied: "submitted",
};

export function applyBoardSearch<T extends { title: string; company: string; notes?: string | null }>(rows: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) =>
    [row.company, row.title, row.notes ?? ""].some((value) => value.toLowerCase().includes(needle)),
  );
}

export type BoardSort = "recent" | "match" | "company";

export function sortBoardRows<T extends { last_update: string; match_score: number | null; company: string; title: string }>(
  rows: T[],
  sort: BoardSort,
): T[] {
  const copy = [...rows];
  if (sort === "match") {
    copy.sort((a, b) => (b.match_score ?? -1) - (a.match_score ?? -1) || b.last_update.localeCompare(a.last_update));
  } else if (sort === "company") {
    copy.sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title));
  } else {
    copy.sort((a, b) => b.last_update.localeCompare(a.last_update));
  }
  return copy;
}
