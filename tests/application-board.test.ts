import assert from "node:assert/strict";
import test from "node:test";
import { APPLICATION_STATUSES } from "../lib/application-status";
import {
  BOARD_COLUMNS,
  CLOSED_STATUSES,
  applyBoardSearch,
  boardColumnForRow,
  groupBoardRows,
  sortBoardRows,
  splitBoardRows,
} from "../lib/application-board";

test("every stored status maps to exactly one board column or the closed list", () => {
  for (const status of APPLICATION_STATUSES) {
    const matches = BOARD_COLUMNS.filter((column) => column.statuses.includes(status));
    const closed = (CLOSED_STATUSES as readonly string[]).includes(status);
    assert.equal(matches.length + (closed ? 1 : 0), 1, `${status} must map to one column`);
  }
});

test("an unverified submitted row is needs-attention, never Applied", () => {
  const unverified = { status: "submitted", submitted_at: null, confirmation: null };
  const halfVerified = { status: "submitted", submitted_at: "2026-11-20T10:00:00.000Z", confirmation: null };
  const verified = { status: "submitted", submitted_at: "2026-11-20T10:00:00.000Z", confirmation: "EMP-4411" };
  assert.equal(boardColumnForRow(unverified), "needs_attention");
  assert.equal(boardColumnForRow(halfVerified), "needs_attention");
  assert.equal(boardColumnForRow(verified), "applied");
});

test("generated documents and blocked packages do not establish Applied", () => {
  for (const status of [
    "documents_preparing",
    "ready_to_submit",
    "quality_review_required",
    "human_intervention_required",
    "submission_unverified",
    "interview_invited",
    "interview_completed",
    "acknowledged",
    "offer_received",
  ]) {
    const column = boardColumnForRow({ status, submitted_at: null, confirmation: null });
    assert.notEqual(column, "applied", `${status} must not be Applied without verified evidence`);
  }
});

test("an interview-stage record without evidence is routed to Needs attention", () => {
  assert.equal(boardColumnForRow({ status: "interview_invited", submitted_at: null, confirmation: null }), "needs_attention");
  assert.equal(boardColumnForRow({ status: "interview_completed", submitted_at: "2026-11-20", confirmation: null }), "needs_attention");
  assert.equal(
    boardColumnForRow({ status: "interview_invited", submitted_at: "2026-11-20", confirmation: "EMP-1" }),
    "applied",
  );
});

test("grouping preserves every open row once and keeps closed rows separate", () => {
  const rows = [
    { id: "a", status: "discovered", submitted_at: null, confirmation: null, last_update: "2026-11-20", match_score: 90, company: "B", title: "QA" },
    { id: "b", status: "ready_to_submit", submitted_at: null, confirmation: null, last_update: "2026-11-19", match_score: 95, company: "A", title: "SDET" },
    { id: "c", status: "submitted", submitted_at: "2026-11-18", confirmation: "REF", last_update: "2026-11-18", match_score: 88, company: "C", title: "Tester" },
    { id: "d", status: "rejected", submitted_at: null, confirmation: null, last_update: "2026-11-17", match_score: 80, company: "D", title: "Lead" },
  ];
  const grouped = groupBoardRows(rows);
  assert.deepEqual(grouped.considering.map((row) => row.id), ["a"]);
  assert.deepEqual(grouped.to_apply.map((row) => row.id), ["b"]);
  assert.deepEqual(grouped.applied.map((row) => row.id), ["c"]);
  assert.deepEqual(grouped.needs_attention, []);
  const split = splitBoardRows(rows);
  assert.equal(split.open.length + split.closed.length, rows.length);
  assert.deepEqual(split.closed.map((row) => row.id), ["d"]);

  const byMatch = sortBoardRows(rows, "match");
  assert.deepEqual(byMatch.map((row) => row.id), ["b", "a", "c", "d"]);
  assert.deepEqual(applyBoardSearch(rows, "sdet").map((row) => row.id), ["b"]);
});
