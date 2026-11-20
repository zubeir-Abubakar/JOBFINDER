import type { VacancyVerification } from "../../lib/vacancy-verification.ts";

/** Explicit controlled fixture for tests that never contact a real employer. */
export function openVacancyVerification(checkedAt = new Date().toISOString()): VacancyVerification {
  return {
    status: "open",
    checkedAt,
    publishedAt: checkedAt,
    publicationStatus: "present",
    expiryAt: null,
    expiryStatus: "unknown",
    expirySource: null,
    reason: "Controlled fixture: the listing is open; no expiry date was supplied.",
    checks: [
      {
        kind: "application",
        url: "https://fixture.test/apply",
        finalUrl: "https://fixture.test/apply",
        httpStatus: 200,
        outcome: "open",
        detail: "Controlled fixture response.",
        identityMatched: true,
      },
    ],
  };
}
