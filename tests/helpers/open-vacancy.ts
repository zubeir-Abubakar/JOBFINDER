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
    route: {
      statuses: [
        "URL_RESOLVED",
        "URL_REACHABLE",
        "EMPLOYER_IDENTITY_VERIFIED",
        "VACANCY_OPEN_VERIFIED",
        "APPLICATION_FORM_SUPPORTED",
      ],
      finalStatus: "APPLICATION_FORM_SUPPORTED",
      urlResolved: true,
      urlReachable: true,
      employerIdentityVerified: true,
      vacancyOpenVerified: true,
      applicationFormSupported: true,
      finalUrl: "https://fixture.test/apply",
      finalHost: "fixture.test",
      httpStatus: 200,
      formEvidence: ["HTML form element", "CV/document upload control"],
      reason: "Controlled fixture: route, identity, open status and form are verified.",
    },
  };
}
