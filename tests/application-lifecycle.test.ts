import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_DROP_TARGETS,
  boardColumnForRow,
  boardCounts,
} from "../lib/application-board";
import {
  hasVerifiedSubmissionEvidence,
  statusRequiresVerifiedSubmission,
  submissionConfirmationSource,
  submissionConfirmationSourceLabel,
  submissionEvidenceLabel,
  validateApplicationStatusTransition,
} from "../lib/application-status";

const noEvidence = { submitted_at: null, confirmation: null };
const partialEvidence = { submitted_at: "2026-11-20T09:00:00.000Z", confirmation: null };
const verified = { submitted_at: "2026-11-20T09:00:00.000Z", confirmation: "EMP-48213" };
const automatedEvidence = {
  ...verified,
  evidence: JSON.stringify({ outcomeClass: "submitted_verified", httpStatus: 200, reference: "EMP-48213" }),
};
const ownerRecordedEvidence = {
  ...verified,
  evidence: JSON.stringify({ source: "manual_record", method: "employer_portal", recordedBy: "u_owner" }),
};

const transition = (
  currentStatus: string,
  nextStatus: string,
  evidence: { submitted_at: string | null; confirmation: string | null } = noEvidence,
  readiness: string | null = null,
) => validateApplicationStatusTransition({ currentStatus, nextStatus, ...evidence, readiness });

test("ready_to_submit cannot move to interview_invited without verified evidence", () => {
  for (const evidence of [noEvidence, partialEvidence]) {
    const decision = transition("ready_to_submit", "interview_invited", evidence);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.match(decision.reason, /verified employer confirmation/i);
  }
});

test("every post-submission status requires the stored timestamp and reference pair", () => {
  for (const status of ["submitted", "acknowledged", "interview", "interview_invited", "interview_completed", "offer_received"]) {
    assert.equal(statusRequiresVerifiedSubmission(status), true);
    assert.equal(transition("ready_to_submit", status).allowed, false, `${status} without evidence`);
    assert.equal(transition("ready_to_submit", status, partialEvidence).allowed, false, `${status} with partial evidence`);
  }
});

test("a valid evidence-backed application can enter post-submission stages", () => {
  assert.equal(hasVerifiedSubmissionEvidence(verified), true);
  assert.equal(transition("ready_to_submit", "submitted", verified).allowed, true);
  assert.equal(transition("submitted", "acknowledged", verified).allowed, true);
  assert.equal(transition("submitted", "interview_invited", verified).allowed, true);
  assert.equal(transition("interview_invited", "interview_completed", verified).allowed, true);
  assert.equal(transition("interview_completed", "offer_received", verified).allowed, true);
});

test("a rejected transition changes nothing in the record it was given", () => {
  const row = { status: "ready_to_submit", ...noEvidence };
  const snapshot = { ...row };
  const decision = transition(row.status, "interview_invited", row);
  assert.equal(decision.allowed, false);
  assert.deepEqual(row, snapshot);
});

test("readiness is still required before ready_to_submit", () => {
  const notReady = transition("documents_preparing", "ready_to_submit", noEvidence, null);
  assert.equal(notReady.allowed, false);
  if (!notReady.allowed) assert.match(notReady.reason, /readiness/i);
  const ready = transition(
    "documents_preparing",
    "ready_to_submit",
    noEvidence,
    JSON.stringify({ ready: true, state: "ready_for_submission" }),
  );
  assert.equal(ready.allowed, true);
});

test("an interview-stage record without evidence is not classified as Applied", () => {
  assert.equal(boardColumnForRow({ status: "interview_invited", ...noEvidence }), "needs_attention");
  assert.equal(boardColumnForRow({ status: "interview_completed", ...noEvidence }), "needs_attention");
  assert.equal(boardColumnForRow({ status: "acknowledged", ...noEvidence }), "needs_attention");
  assert.equal(boardColumnForRow({ status: "offer_received", ...partialEvidence }), "needs_attention");
  assert.equal(boardColumnForRow({ status: "interview_invited", ...verified }), "applied");
  assert.equal(boardColumnForRow({ status: "offer_received", ...verified }), "applied");
});

test("a bare submitted record cannot be re-confirmed by a no-op status save", () => {
  const decision = transition("submitted", "submitted");
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.match(decision.reason, /verified employer confirmation/i);
  assert.equal(transition("submitted", "submitted", verified).allowed, true);
});

test("a bare submitted record without evidence is classified correctly", () => {
  assert.equal(boardColumnForRow({ status: "submitted", ...noEvidence }), "needs_attention");
  assert.equal(boardColumnForRow({ status: "submitted", ...partialEvidence }), "needs_attention");
  assert.equal(boardColumnForRow({ status: "submitted", ...verified }), "applied");
  assert.equal(boardColumnForRow({ status: "ready_to_submit", ...noEvidence }), "to_apply");
});

test("submission_unverified is never described as employer-confirmed", () => {
  const label = submissionEvidenceLabel({ status: "submission_unverified", ...noEvidence } as never);
  assert.equal(label, "No verified submission evidence");
  assert.doesNotMatch(label, /employer-confirmed/i);
  assert.equal(submissionEvidenceLabel(partialEvidence), "Attempted — not verified");
  assert.doesNotMatch(submissionEvidenceLabel(partialEvidence), /employer-confirmed/i);
  assert.equal(submissionEvidenceLabel(verified), "Employer-confirmed");
});

test("automated and owner-recorded confirmations stay distinct without implying portal automation", () => {
  assert.equal(submissionConfirmationSource(automatedEvidence), "automated_employer");
  assert.equal(submissionConfirmationSource(ownerRecordedEvidence), "owner_recorded");
  assert.equal(submissionConfirmationSource({ evidence: null }), "unknown");
  assert.equal(submissionConfirmationSource({ evidence: "not-json" }), "unknown");

  assert.equal(submissionEvidenceLabel(automatedEvidence), "Employer-confirmed · automated portal response");
  assert.equal(submissionEvidenceLabel(ownerRecordedEvidence), "Employer-confirmed · recorded by owner");
  assert.match(submissionConfirmationSourceLabel(ownerRecordedEvidence), /owner-recorded/i);
  assert.match(submissionConfirmationSourceLabel(ownerRecordedEvidence), /not an automated portal response/i);
  assert.match(submissionConfirmationSourceLabel(automatedEvidence), /automated employer portal/i);
  // A historical row without a channel is not silently upgraded to automated.
  assert.equal(submissionEvidenceLabel(verified), "Employer-confirmed");
  assert.match(submissionConfirmationSourceLabel({ evidence: null }), /not recorded/i);
});

test("board counting uses the same rows, so headers, cards and totals reconcile", () => {
  const rows = [
    { id: "considering", status: "discovered", ...noEvidence },
    { id: "to-apply-1", status: "ready_to_submit", ...noEvidence },
    { id: "to-apply-2", status: "documents_preparing", ...noEvidence },
    { id: "applied-1", status: "submitted", ...verified },
    { id: "applied-2", status: "interview_invited", ...verified },
    { id: "attention-1", status: "submitted", ...noEvidence },
    { id: "attention-2", status: "interview_invited", ...noEvidence },
    { id: "attention-3", status: "submission_unverified", ...noEvidence },
    { id: "closed-1", status: "rejected", ...noEvidence },
  ];
  const counts = boardCounts(rows);
  assert.deepEqual(
    {
      considering: counts.considering,
      to_apply: counts.to_apply,
      applied: counts.applied,
      needs_attention: counts.needs_attention,
      closed: counts.closed,
      total: counts.total,
    },
    { considering: 1, to_apply: 2, applied: 2, needs_attention: 3, closed: 1, total: 9 },
  );
  assert.equal(counts.considering + counts.to_apply + counts.applied + counts.needs_attention + counts.closed, counts.total);
  // Overview and Applications share this classification, so their metrics are
  // these same numbers rather than independent aggregate queries.
  assert.equal(counts.applied, rows.filter((row) => boardColumnForRow(row) === "applied").length);
  assert.equal(counts.needs_attention, rows.filter((row) => boardColumnForRow(row) === "needs_attention").length);
});

test("drag targets pass through the same validator as the status form", () => {
  assert.equal(BOARD_DROP_TARGETS.applied, "submitted");
  assert.equal(BOARD_DROP_TARGETS.considering, "under_review");
  assert.equal(BOARD_DROP_TARGETS.to_apply, "documents_preparing");
  assert.equal(BOARD_DROP_TARGETS.needs_attention, undefined);

  const rejectedDrop = transition("ready_to_submit", BOARD_DROP_TARGETS.applied!, noEvidence);
  assert.equal(rejectedDrop.allowed, false);
  const rejectedForm = transition("ready_to_submit", "interview_invited", noEvidence);
  assert.equal(rejectedForm.allowed, false);

  const acceptedDrop = transition("documents_preparing", BOARD_DROP_TARGETS.applied!, verified);
  assert.equal(acceptedDrop.allowed, true);
});
