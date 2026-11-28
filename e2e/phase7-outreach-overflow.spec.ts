import { test, expect, gotoReady } from "./support/fixtures";
import { execute } from "./support/db";

/**
 * Regression guard for the Phase 7 mobile defect: the outreach tables rendered
 * as cards at 390px but kept their desktop intrinsic width, so the recipient,
 * subject and email columns were clipped.
 *
 * The isolated E2E database stores no outreach draft (the empty state is
 * asserted elsewhere), so this file creates its own job → application →
 * contact → draft fixture with deliberately long strings, then removes it. It
 * never touches the owner's real database.
 */
const CONTACT_ID = "contact_e2e_overflow";
const DRAFT_ID = "draft_e2e_overflow";
const JOB_ID = "job_e2e_overflow";
const APPLICATION_ID = "app_e2e_overflow";
const LONG_EMAIL = "careers.testing.with.a.long.address@example-employer.ch";

test.beforeAll(() => {
  const now = new Date().toISOString();
  // The suite starts from an empty database, so the fixture owns its whole
  // job -> application -> contact -> draft graph instead of depending on the
  // order in which other specs happen to seed theirs.
  execute(
    `INSERT OR REPLACE INTO jobs (id, source, title, company, discovered_at)
     VALUES (?, 'e2e-overflow', ?, ?, ?)`,
    JOB_ID,
    "Test Engineer — mobile layout regression fixture",
    "Telecom26 AG",
    now,
  );
  execute(
    `INSERT OR REPLACE INTO applications (id, job_id, status, last_update, created_at)
     VALUES (?, ?, 'ready_to_submit', ?, ?)`,
    APPLICATION_ID,
    JOB_ID,
    now,
    now,
  );
  execute(
    `INSERT OR REPLACE INTO outreach_contacts
       (id, job_id, name, title, company, email, email_domain, source_url, source_kind,
        discovery_method, evidence, confidence, priority, verification_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?)`,
    CONTACT_ID,
    JOB_ID,
    "Recruitment team with a published employer address",
    "Talent Acquisition Partner",
    "Telecom26 AG",
    LONG_EMAIL,
    "example-employer.ch",
    "https://example-employer.ch/careers",
    "employer_site",
    "careers_page",
    "{}",
    90,
    1,
    now,
    now,
  );
  execute(
    `INSERT OR REPLACE INTO outreach_drafts
       (id, application_id, job_id, contact_id, recipient, subject, body,
        cv_document_id, cover_document_id, cv_sha256, cover_sha256, attachment_manifest,
        gmail_draft_id, status, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, 'draft_created', ?, ?, ?)`,
    DRAFT_ID,
    APPLICATION_ID,
    JOB_ID,
    CONTACT_ID,
    LONG_EMAIL,
    "Test Engineer — application from ABUBAKAR TOWFIQ (mobile layout regression fixture)",
    "Fixture body used only to make the outreach table render one populated row at 390px.",
    "doc_e2e_overflow_cv",
    "doc_e2e_overflow_cover",
    "0".repeat(64),
    "0".repeat(64),
    "e2e-outreach-overflow-1",
    now,
    now,
  );
});

test.afterAll(() => {
  execute("DELETE FROM outreach_drafts WHERE id = ?", DRAFT_ID);
  execute("DELETE FROM outreach_contacts WHERE id = ?", CONTACT_ID);
  execute("DELETE FROM applications WHERE id = ?", APPLICATION_ID);
  execute("DELETE FROM jobs WHERE id = ?", JOB_ID);
});

const geometry = () =>
  ({
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    wrapOverflow: (() => {
      const wrap = document.querySelector("table.responsive-cards")?.closest(".table-wrap");
      return wrap ? wrap.scrollWidth - wrap.clientWidth : -1;
    })(),
    clippedCells: [...document.querySelectorAll("table.responsive-cards tbody td")]
      .filter((cell) => cell.scrollWidth - cell.clientWidth > 1)
      .map((cell) => cell.getAttribute("data-label") ?? "unknown"),
    emailRight: Math.round(
      ([...document.querySelectorAll("table.responsive-cards tbody td")].find((cell) =>
        cell.textContent?.includes("careers.testing.with.a.long.address"),
      )?.getBoundingClientRect().right ?? 0),
    ),
  });

test("the populated outreach tables never clip their cards at 390px", async ({ page, diagnostics }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  for (const path of ["/outreach", "/dashboard"]) {
    await gotoReady(page, path);
    const table = page.locator("table.responsive-cards").first();
    await expect(table).toBeVisible();
    await expect(table).toContainText(LONG_EMAIL);

    const measured = await page.evaluate(geometry);
    expect(measured.pageOverflow, `${path} must not overflow the page at 390px`).toBeLessThanOrEqual(1);
    expect(measured.wrapOverflow, `${path} table wrapper must not scroll horizontally at 390px`).toBeLessThanOrEqual(1);
    expect(measured.clippedCells, `${path} cells must not clip their content`).toEqual([]);
    expect(measured.emailRight, `${path} recipient email must stay inside the 390px viewport`).toBeLessThanOrEqual(390);
  }

  diagnostics.assertClean();
});
