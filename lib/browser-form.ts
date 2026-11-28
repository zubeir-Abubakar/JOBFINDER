/**
 * Local Playwright executor for candidate-facing application forms.
 *
 * Some employers render the whole application with JavaScript, or load the
 * fields after the initial HTML. The HTTP parser in candidate-forms.ts cannot
 * fill those forms, but a human candidate would simply use a browser. This
 * module does the same with the locally installed Chromium: it renders the
 * page, maps every visible question to the same verified-answer rules, uploads
 * the tailored documents, validates each answer, clicks the employer's own
 * submit control and reads the confirmation.
 *
 * It never solves a CAPTCHA, enters credentials, bypasses MFA, pays a fee or
 * invents an answer. Those are returned as explicit blockers so the
 * application keeps its state and another eligible vacancy can proceed.
 */

import {
  answerFor,
  categoryFor,
  classifySuccess,
  detectSecurity,
  type CandidateDocuments,
  type CandidateField,
  type CandidateFormPlan,
  type CandidateFormResult,
  type CandidateProfile,
  type CandidateQuestion,
} from "./candidate-forms";
import { isAggregatorUrl } from "./job-identity";
import { assertPublicHttpUrl } from "./outbound-url";
import type { Browser, Frame, Page } from "playwright";

type ExtractedControl = {
  name: string;
  label: string;
  groupLabel: string;
  type: string;
  required: boolean;
  hidden: boolean;
  accept: string | null;
  value: string | null;
  options: Array<{ value: string; label: string }>;
  selector: string | null;
  optionLabel: string | null;
  /** Caption of the surrounding field wrapper, without the control's placeholder. */
  context: string;
};

type ExtractedForm = {
  formFound: boolean;
  action: string | null;
  fields: ExtractedControl[];
  submit: { selector: string; kind: "next" | "submit"; label: string } | null;
};

/** Page and Frame expose the same locator/evaluate surface used by this executor. */
type FormScope = Page | Frame;

type FrameSnapshot = {
  url: string;
  origin: string | null;
  ancestorOrigins: string[];
  controls: number;
  visibleControls: number;
  files: number;
  hasForm: boolean;
  applicationSignal: number;
};

export type FieldGroup = {
  field: CandidateField;
  controls: ExtractedControl[];
  kind: "text" | "select" | "file" | "check" | "radio";
};

export type BrowserFormProbe = {
  executor: "playwright";
  pageUrl: string;
  finalUrl: string;
  formFound: boolean;
  fields: number;
  filledFields: string[];
  submit: { selector: string; kind: "next" | "submit"; label: string } | null;
  applicationFrame: ReturnType<typeof frameEvidence>;
  screenshot: string | null;
};

export type BrowserFormRun = {
  plan: CandidateFormPlan;
  result: CandidateFormResult;
  /** Present only when the caller asked to inspect and fill without submitting. */
  probe?: BrowserFormProbe;
};

type BrowserFormInput = {
  pageUrl: string;
  jobTitle: string;
  company: string;
  profile: CandidateProfile;
  documents: CandidateDocuments;
  authorised?: Record<string, string>;
  /** Additional form-provider hosts the caller has tied to this employer. */
  allowedFrameHosts?: string[];
  /**
   * Verification-only mode: render, detect, fill and validate every field, then
   * stop before activating any submit or next control. Nothing is sent.
   */
  probeOnly?: boolean;
  /** Optional screenshot path for probe evidence. */
  screenshotPath?: string;
};

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 AT-AI-Workforce/2.6";

const MAX_STEPS = 4;
const STEP_TIMEOUT_MS = 20_000;
const IFRAME_WAIT_MS = 12_000;
const IFRAME_POLL_MS = 150;
const MAX_IFRAME_DEPTH = 1;

/**
 * Cross-origin frames are never entered by default. These are form providers
 * that employers commonly embed directly; the frame must also be a direct child
 * of the verified employer page and contain employer/application semantics.
 */
const DEFAULT_APPROVED_FORM_FRAME_HOSTS = ["forms.clickup.com"];

function cssValue(value: string): string {
  return JSON.stringify(value);
}

function mimeFor(name: string): string {
  if (/\.docx$/i.test(name)) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (/\.doc$/i.test(name)) return "application/msword";
  if (/\.txt$/i.test(name)) return "text/plain";
  return "application/pdf";
}

function fieldKey(control: ExtractedControl): string {
  return `${control.type}:${control.name}`;
}

/**
 * Group repeated radios/checkboxes into one question. Each option keeps its own
 * selector so the verified answer is applied to the exact control the employer
 * rendered.
 */
function groupFields(controls: ExtractedControl[]): FieldGroup[] {
  const groups: FieldGroup[] = [];
  const seen = new Map<string, FieldGroup>();
  for (const control of controls) {
    if (!control.name || control.type === "hidden" || control.hidden) continue;
    if (["submit", "button", "reset", "image"].includes(control.type)) continue;
    const isChoice = control.type === "radio" || control.type === "checkbox";
    if (isChoice) {
      const key = fieldKey(control);
      const existing = seen.get(key);
      if (existing) {
        existing.controls.push(control);
        if (!existing.field.label || existing.field.label === existing.field.name) {
          existing.field.label = control.groupLabel || control.label || existing.field.label;
        }
        existing.field.options.push({ value: control.value ?? "on", label: control.label || control.value || "on" });
        existing.field.required = existing.field.required || control.required;
        continue;
      }
      const group: FieldGroup = {
        field: {
          name: control.name,
          label: control.groupLabel || control.label || control.name,
          type: control.type,
          required: control.required,
          options: [{ value: control.value ?? "on", label: control.label || control.value || "on" }],
          hidden: false,
          accept: control.accept,
          value: null,
        },
        controls: [control],
        kind: control.type === "radio" ? "radio" : "check",
      };
      seen.set(key, group);
      groups.push(group);
      continue;
    }
    groups.push({
      field: {
        name: control.name,
        // Upload widgets frequently share one placeholder. The wrapper caption
        // is preferred over the placeholder so the CV and cover-letter fields
        // are told apart by real form structure, not by shared text.
        label: control.label || control.context || control.name,
        type: control.type === "textarea" ? "textarea" : control.type === "select" ? "select" : control.type === "file" ? "file" : "text",
        required: control.required,
        options: control.options,
        hidden: false,
        accept: control.accept,
        value: null,
        context: control.context || undefined,
      },
      controls: [control],
      kind: control.type === "select" ? "select" : control.type === "file" ? "file" : "text",
    });
  }
  return groups;
}

function uploadSignature(group: FieldGroup): string {
  const field = group.field;
  // A generated DOM id ("cu-form-file-field-input-4") does not say which
  // document belongs in the field. Only a semantic name does.
  const semanticName = /cv|resume|curriculum|cover|motivation|lebenslauf|anschreiben/i.test(field.name)
    ? field.name
    : "";
  return [semanticName, field.label, field.context ?? "", field.accept ?? ""]
    .join("|")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A form can render several upload controls that are indistinguishable by DOM
 * name, label, caption and `accept` type. Filling all of them with the CV would
 * attach the CV to the wrong question, so the run stops and names the ambiguity
 * instead. This is what the Digt ClickUp form exposed.
 */
export function fileUploadBlocker(groups: FieldGroup[]): string | null {
  const uploads = groups.filter((group) => group.kind === "file");
  if (uploads.length <= 1) return null;
  const signatures = new Map<string, FieldGroup[]>();
  for (const group of uploads) {
    const signature = uploadSignature(group);
    signatures.set(signature, [...(signatures.get(signature) ?? []), group]);
  }
  const identical = [...signatures.values()].filter((list) => list.length > 1);
  if (identical.length > 0) {
    const fields = identical[0];
    return `The form has ${fields.length} upload fields that cannot be told apart ("${fields[0].field.label}"): their DOM names, labels and accept types are identical. No file was attached to them and nothing was sent. The owner must say which field accepts the CV and which accepts the cover letter before a future attempt.`;
  }
  const byCategory = new Map<string, FieldGroup[]>();
  for (const group of uploads) {
    const category = categoryFor(group.field);
    byCategory.set(category, [...(byCategory.get(category) ?? []), group]);
  }
  const duplicated = [...byCategory.entries()].find(([category, list]) => category !== "unknown_file" && list.length > 1);
  if (duplicated) {
    return `The form has ${duplicated[1].length} upload fields that all read as "${duplicated[0].replace(/_/g, " ")}" with no way to tell them apart. No file was attached to them and nothing was sent.`;
  }
  return null;
}

async function visibleSecurityBlocker(scope: FormScope): Promise<string | null> {
  const challenge = await scope.evaluate(() => {
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const selectors = [
      'iframe[src*="recaptcha" i]',
      'iframe[src*="hcaptcha" i]',
      ".g-recaptcha",
      ".h-captcha",
      "[data-sitekey]",
      'input[name*="captcha" i]',
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) if (visible(element)) return selector;
    }
    return null;
  });
  if (challenge) return "The application form contains a CAPTCHA, which is never bypassed.";

  const bodyText = await scope.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  const security = detectSecurity(bodyText);
  if (!security) return null;
  if (/account login/i.test(security)) {
    // Many employers show "Already have an account? Sign in" beside a guest
    // application form. Only a real password field makes login mandatory.
    const password = await scope
      .locator('input[type="password"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (!password) return null;
  }
  return security;
}

/**
 * JavaScript ATS pages render their form after the document loads. Extraction
 * must wait for a bounded moment instead of declaring the page empty on the
 * first synchronous paint.
 */
async function waitForRenderedControls(scope: FormScope, timeoutMs = 8_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  let stable = 0;
  while (Date.now() < deadline) {
    // Hydrating forms often render a skeleton first and append dynamic
    // questions later. A form may publish an explicit readiness marker; absent
    // one, wait until the visible control count has stopped changing instead of
    // extracting the first non-empty skeleton.
    const ready = await scope
      .locator('[data-form-ready="true"], form[data-ready="true"]')
      .count()
      .catch(() => 0);
    const next = await scope
      .locator('input:visible, textarea:visible, select:visible')
      .count()
      .catch(() => 0);
    if (next > 0) {
      if (ready > 0) return next;
      if (next === count) stable += 1;
      else stable = 0;
      if (stable >= 2) return next;
    }
    count = next;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return count;
}

async function extractForm(scope: FormScope): Promise<ExtractedForm> {
  return scope.evaluate(() => {
    const controlSelector = 'input, textarea, select';
    const cssValue = (value: string) => JSON.stringify(value);
    const isVisible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const textOf = (element: Element | null): string => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

    const labelFor = (element: Element): string => {
      const id = element.getAttribute("id");
      if (id) {
        const explicit = document.querySelector(`label[for=${cssValue(id)}]`);
        if (textOf(explicit)) return textOf(explicit);
      }
      const wrapping = element.closest("label");
      if (textOf(wrapping)) return textOf(wrapping);
      const aria = element.getAttribute("aria-label") ?? element.getAttribute("placeholder");
      if (aria?.trim()) return aria.trim();
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const parts = labelledBy
          .split(/\s+/)
          .map((part) => textOf(document.getElementById(part)))
          .filter(Boolean);
        if (parts.length) return parts.join(" ");
      }
      return "";
    };

    const groupLabelFor = (element: Element): string => {
      const fieldset = element.closest("fieldset");
      if (fieldset) {
        const legend = textOf(fieldset.querySelector("legend"));
        if (legend) return legend;
      }
      const group = element.closest('[role="group"], [role="radiogroup"]');
      const aria = group?.getAttribute("aria-label");
      if (aria?.trim()) return aria.trim();
      return "";
    };

    // The visible caption of an upload control's field wrapper. The control's
    // own placeholder is excluded by removing form controls from a clone.
    const contextFor = (element: Element): string => {
      let node: Element | null = element.parentElement;
      for (let depth = 0; depth < 3 && node; depth += 1) {
        const tag = node.tagName.toLowerCase();
        // Never read the whole form or page: that would mix the CV caption with
        // the cover-letter caption and mislabel both fields.
        if (tag === "form" || tag === "body" || tag === "html") break;
        const controlCount = node.querySelectorAll("input, textarea, select").length;
        if (controlCount <= 2) {
          const clone = node.cloneNode(true) as Element;
          Array.from(clone.querySelectorAll("input, textarea, select, button, script, style")).forEach((child) =>
            child.remove(),
          );
          const text = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
          if (text.length >= 2 && text.length <= 120) return text;
        }
        node = node.parentElement;
      }
      return "";
    };

    const selectorFor = (element: Element): string | null => {
      const id = element.getAttribute("id");
      if (id) return `#${CSS.escape(id)}`;
      const name = element.getAttribute("name");
      if (name) {
        const tag = element.tagName.toLowerCase();
        const base = `${tag}[name=${cssValue(name)}]`;
        const type = (element.getAttribute("type") ?? "").toLowerCase();
        if (type === "radio" || type === "checkbox") {
          const value = element.getAttribute("value");
          if (value !== null) return `${base}[value=${cssValue(value)}]`;
        }
        return base;
      }
      const controls = Array.from(document.querySelectorAll(controlSelector));
      const index = controls.indexOf(element);
      return index >= 0 ? `${controlSelector}:nth-of-type(${index + 1})` : null;
    };

    const forms = Array.from(document.querySelectorAll("form"));
    const score = (form: HTMLFormElement): number => {
      const controls = Array.from(form.querySelectorAll(controlSelector)).filter(
        (element) => (element as HTMLInputElement).type !== "hidden",
      );
      const files = form.querySelectorAll('input[type="file"]').length;
      return controls.length + files * 8;
    };
    const form = forms.sort((left, right) => score(right) - score(left))[0] ?? null;
    const scope: ParentNode = form ?? document;
    const rawControls = Array.from(scope.querySelectorAll(controlSelector));

    const fields = rawControls.map((element): ExtractedControl => {
      const input = element as HTMLInputElement;
      const type = (element.getAttribute("type") ?? (element.tagName.toLowerCase() === "textarea" ? "textarea" : element.tagName.toLowerCase() === "select" ? "select" : "text")).toLowerCase();
      const options =
        element.tagName.toLowerCase() === "select"
          ? Array.from((element as HTMLSelectElement).options).map((option) => ({
              value: option.value,
              label: textOf(option) || option.value,
            }))
          : [];
      // React/Greenhouse/ClickUp forms frequently omit `name` and identify a
      // control only by id or aria-label. Dropping those controls made a
      // perfectly visible form look empty.
      const name =
        (element.getAttribute("name") ?? "").trim() ||
        (element.getAttribute("id") ?? "").trim() ||
        (element.getAttribute("aria-label") ?? "").trim() ||
        (element.getAttribute("placeholder") ?? "").trim();
      return {
        name,
        label: labelFor(element),
        groupLabel: groupLabelFor(element),
        type,
        required: element.hasAttribute("required") || element.getAttribute("aria-required") === "true",
        // CSS-hidden conditional fields are not questions yet. Hidden file
        // inputs remain usable because custom upload widgets often hide the
        // native control behind a drop zone.
        hidden: type === "hidden" || (type !== "file" && !isVisible(element)),
        accept: element.getAttribute("accept"),
        value: element.getAttribute("value"),
        options,
        selector: selectorFor(element),
        optionLabel: textOf(element.closest("label")),
        context: type === "file" ? contextFor(element) : "",
      };
    });

    const submitCandidates = Array.from(
      scope.querySelectorAll('button, input[type="submit"], input[type="button"]'),
    ).filter((element) => isVisible(element));
    const choose = (pattern: RegExp) =>
      submitCandidates.find((element) => {
        const label =
          element.tagName.toLowerCase() === "input"
            ? (element as HTMLInputElement).value
            : (element.textContent ?? "");
        return pattern.test(label);
      }) ?? null;
    const next = choose(/\b(next|continue|weiter|suivant|siguiente)\b/i);
    const finish = choose(/\b(submit|apply|send|bewerben|absenden|complete)\b/i);
    const chosen = finish ?? next;
    const submit = chosen
      ? {
          selector: (() => {
            const id = chosen.getAttribute("id");
            if (id) return `#${CSS.escape(id)}`;
            const kind = chosen.tagName.toLowerCase() === "button" ? "button" : 'input[type="submit"]';
            return kind;
          })(),
          kind: (finish ? "submit" : "next") as "submit" | "next",
          label:
            chosen.tagName.toLowerCase() === "input"
              ? (chosen as HTMLInputElement).value
              : (chosen.textContent ?? "").replace(/\s+/g, " ").trim(),
        }
      : null;

    return {
      formFound: Boolean(form),
      action: form?.getAttribute("action") ?? null,
      fields,
      submit,
    };
  });
}

function planFor(input: {
  pageUrl: string;
  action: string | null;
  groups: FieldGroup[];
  questions: CandidateQuestion[];
  blockers: string[];
  status?: CandidateFormPlan["status"];
  detail?: string;
}): CandidateFormPlan {
  const blockers = input.blockers;
  return {
    status:
      input.status ??
      (blockers.length > 0 ? "intervention" : "ready"),
    detail:
      input.detail ??
      (blockers.length > 0
        ? `${blockers.length} essential question(s) cannot be answered from verified information: ${blockers.join(" ")}`
        : `Browser form ready: ${input.questions.filter((question) => question.action === "answer").length} verified answer(s), ${input.questions.filter((question) => question.action === "blank").length} optional field(s) left blank.`),
    pageUrl: input.pageUrl,
    action: input.action ?? input.pageUrl,
    method: "post",
    fields: input.groups.map((group) => group.field),
    questions: input.questions,
    blockers,
    cookies: null,
  };
}

function blockedBrowserResult(
  plan: CandidateFormPlan,
  externalRequirement: string | null,
  selection: FrameSelection | null = null,
): CandidateFormResult {
  return {
    status: "blocked",
    detail: plan.detail,
    httpStatus: null,
    reference: null,
    endpoint: plan.action,
    finalUrl: plan.pageUrl,
    evidence: {
      sent: false,
      executor: "playwright",
      blockers: plan.blockers,
      questions: plan.questions,
      externalRequirement,
      applicationFrame: frameEvidence(selection),
    },
  };
}

function externalRequirementFor(questions: CandidateQuestion[], security: string | null): string | null {
  if (security) return "security_challenge";
  if (questions.some((question) => question.action === "intervention" && question.category === "legal")) {
    return "legal_declaration";
  }
  return null;
}

async function fillField(
  scope: FormScope,
  group: FieldGroup,
  question: CandidateQuestion,
  documents: CandidateDocuments,
): Promise<string | null> {
  if (question.action !== "answer" || question.answer === null) return null;
  try {
    if (group.kind === "file") {
      // The field must have been identified as the CV or the cover letter from
      // its own DOM structure. An unidentified upload is a blocker upstream,
      // never a default CV upload.
      if (question.category !== "cv_file" && question.category !== "cover_file") {
        return "The upload field could not be identified as the CV or the cover letter.";
      }
      const file = question.category === "cover_file" ? documents.cover : documents.cv;
      if (!file) return "The required document is not available.";
      const control = group.controls[0];
      if (!control.selector) return "The upload field has no usable selector.";
      await scope.locator(control.selector).first().setInputFiles({
        name: file.name,
        mimeType: mimeFor(file.name),
        buffer: file.buffer,
      });
      return null;
    }
    if (group.kind === "radio" || group.kind === "check") {
      const selected = group.controls.find(
        (control) => (control.value ?? "on") === question.answer || control.optionLabel === question.answer,
      );
      if (!selected?.selector) return "The selected option has no usable selector.";
      await scope.locator(selected.selector).first().check({ timeout: 10_000 });
      return null;
    }
    if (group.kind === "select") {
      const control = group.controls[0];
      if (!control.selector) return "The select field has no usable selector.";
      await scope.locator(control.selector).first().selectOption(question.answer, { timeout: 10_000 });
      return null;
    }
    const control = group.controls[0];
    if (!control.selector) return "The field has no usable selector.";
    await scope.locator(control.selector).first().fill(question.answer, { timeout: 10_000 });
    return null;
  } catch (error) {
    return `The form field could not be completed: ${error instanceof Error ? error.message : "unknown field error"}.`;
  }
}

/** Every completed control is read back. A controlled component that discards a verified value stops the send. */
/** URL controls often normalise a verified value (add https://, strip a
 * trailing slash or www). That is not a changed answer. */
function comparableValue(value: string, group: FieldGroup): string {
  const raw = value.trim();
  const urlish =
    group.field.type === "url" ||
    /url|website|linkedin|homepage|portfolio/i.test(`${group.field.label} ${group.field.name}`);
  if (!urlish) return raw;
  return raw
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Upload persistence is checked by filename, not by a non-zero count: a widget
 * can keep a placeholder file while discarding the validated document.
 */
export function uploadPersistenceIssue(kept: string[], expected: string | null): string | null {
  if (kept.length === 0) return "The uploaded document was cleared by the form.";
  if (expected && !kept.includes(expected)) {
    return `The form kept "${kept.join(", ")}" instead of the validated document "${expected}".`;
  }
  return null;
}

async function verifyField(scope: FormScope, group: FieldGroup, question: CandidateQuestion): Promise<string | null> {
  if (question.action !== "answer" || question.answer === null) return null;
  try {
    if (group.kind === "file") {
      const control = group.controls[0];
      if (!control.selector) return "The upload field has no usable selector.";
      const names = await scope
        .locator(control.selector)
        .first()
        .evaluate((element) =>
          Array.from((element as HTMLInputElement).files ?? []).map((file) => file.name),
        );
      return uploadPersistenceIssue(names, question.answer);
    }
    if (group.kind === "radio" || group.kind === "check") {
      const selected = group.controls.find(
        (control) => (control.value ?? "on") === question.answer || control.optionLabel === question.answer,
      );
      if (!selected?.selector) return "The selected option has no usable selector.";
      return (await scope.locator(selected.selector).first().isChecked()) ? null : "The form did not keep the selected answer.";
    }
    if (group.kind === "select") {
      const control = group.controls[0];
      if (!control.selector) return "The select field has no usable selector.";
      const value = await scope.locator(control.selector).first().inputValue();
      return value === question.answer ? null : `The form selected "${value}" instead of the verified option.`;
    }
    const control = group.controls[0];
    if (!control.selector) return "The field has no usable selector.";
    const value = await scope.locator(control.selector).first().inputValue();
    if (comparableValue(value, group) !== comparableValue(question.answer, group)) {
      return `The form changed the verified value for "${group.field.label || group.field.name}".`;
    }
    if (group.field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
      return `The form does not contain a valid email address for "${group.field.label || group.field.name}".`;
    }
    return null;
  } catch (error) {
    return `The completed field could not be verified: ${error instanceof Error ? error.message : "unknown verification error"}.`;
  }
}

type FrameSelection = {
  frame: Frame;
  kind: "main" | "same-origin" | "approved-provider";
  url: string;
  origin: string;
  ancestorOrigins: string[];
  score: number;
  association: string;
};

type FrameSelectionResult =
  | { ok: true; selection: FrameSelection }
  | { ok: false; detail: string };

function originOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

function approvedFrameHosts(extra: string[] | undefined): Set<string> {
  const configured = (process.env.RECRUITMENT_IFRAME_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return new Set(
    [...DEFAULT_APPROVED_FORM_FRAME_HOSTS, ...configured, ...(extra ?? [])]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function iframeWaitMs(): number {
  const configured = Number(process.env.RECRUITMENT_IFRAME_WAIT_MS);
  if (!Number.isFinite(configured)) return IFRAME_WAIT_MS;
  return Math.max(0, Math.min(30_000, Math.trunc(configured)));
}

async function snapshotFrame(frame: Frame): Promise<FrameSnapshot | null> {
  try {
    return await frame.evaluate(() => {
      const visible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const controls = Array.from(
        document.querySelectorAll('input:not([type="hidden"]), textarea, select'),
      ).filter(visible);
      const labels = Array.from(document.querySelectorAll("label"))
        .map((label) => (label.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const attributes = controls
        .map((control) =>
          [
            control.getAttribute("name"),
            control.getAttribute("aria-label"),
            control.getAttribute("placeholder"),
          ]
            .filter(Boolean)
            .join(" "),
        )
        .join(" ");
      const text = `${labels.join(" ")} ${attributes} ${(document.body?.innerText ?? "").slice(0, 4000)}`;
      const signals = text.match(
        /\b(?:e-?mail|phone|telefon|name|resume|curriculum|\bcv\b|cover|motivation|linkedin|application|apply|bewerb|department|reference language|nationality|salary|upload)\b/gi,
      ) ?? [];
      return {
        url: location.href,
        origin: /^https?:$/.test(location.protocol) ? location.origin : null,
        ancestorOrigins: Array.from(location.ancestorOrigins ?? []),
        controls: document.querySelectorAll('input:not([type="hidden"]), textarea, select').length,
        visibleControls: controls.length,
        files: document.querySelectorAll('input[type="file"]').length,
        hasForm: Boolean(document.querySelector("form")),
        applicationSignal: new Set(signals.map((value) => value.toLowerCase())).size,
      };
    });
  } catch {
    return null;
  }
}

/**
 * Finds the form a candidate would see, including a directly embedded provider
 * frame. A cross-origin frame is entered only when its host is explicitly
 * approved, its first ancestor is the verified employer origin, and it contains
 * application fields rather than a newsletter, advert or support widget.
 */
async function waitForApplicationFrame(
  page: Page,
  allowedHosts: Set<string>,
  timeoutMs = iframeWaitMs(),
): Promise<FrameSelectionResult> {
  const deadline = Date.now() + timeoutMs;
  const rejected = new Map<string, string>();
  const mainOrigin = originOf(page.url());

  while (Date.now() <= deadline) {
    const candidates: FrameSelection[] = [];
    for (const frame of page.frames()) {
      if (frame.isDetached()) continue;
      const snapshot = await snapshotFrame(frame);
      if (!snapshot || snapshot.visibleControls === 0) continue;
      const score = snapshot.visibleControls + snapshot.files * 8 + (snapshot.hasForm ? 2 : 0);

      if (frame === page.mainFrame()) {
        if (!snapshot.origin) continue;
        candidates.push({
          frame,
          kind: "main",
          url: snapshot.url,
          origin: snapshot.origin,
          ancestorOrigins: [],
          score,
          association: "Main employer document.",
        });
        continue;
      }

      if (frame.parentFrame() !== page.mainFrame()) {
        rejected.set(snapshot.url || "about:blank", "Nested frames are not inspected.");
        continue;
      }
      if (!snapshot.origin) {
        rejected.set(snapshot.url || "about:blank", "The frame has no public HTTP(S) origin.");
        continue;
      }
      try {
        assertPublicHttpUrl(snapshot.url);
      } catch {
        rejected.set(snapshot.url, "The frame is not a public HTTP(S) address.");
        continue;
      }
      if (mainOrigin && snapshot.origin === mainOrigin) {
        candidates.push({
          frame,
          kind: "same-origin",
          url: snapshot.url,
          origin: snapshot.origin,
          ancestorOrigins: snapshot.ancestorOrigins,
          score,
          association: "Directly embedded same-origin application frame.",
        });
        continue;
      }

      let host = "";
      try {
        host = new URL(snapshot.url).hostname.toLowerCase();
      } catch {
        rejected.set(snapshot.url, "The frame URL is malformed.");
        continue;
      }
      if (!allowedHosts.has(host)) {
        rejected.set(snapshot.url, `Unapproved third-party frame host ${host}.`);
        continue;
      }
      if (!mainOrigin || snapshot.ancestorOrigins[0] !== mainOrigin) {
        rejected.set(snapshot.url, "The frame is not directly embedded by the verified employer page.");
        continue;
      }
      if (snapshot.files === 0 && snapshot.applicationSignal < 2) {
        rejected.set(snapshot.url, "The third-party frame does not contain application fields.");
        continue;
      }
      candidates.push({
        frame,
        kind: "approved-provider",
        url: snapshot.url,
        origin: snapshot.origin,
        ancestorOrigins: snapshot.ancestorOrigins,
        score,
        association: `${host} form directly embedded by ${mainOrigin} with application-specific fields.`,
      });
    }

    candidates.sort((left, right) => right.score - left.score);
    if (candidates.length > 0) {
      const top = candidates[0];
      const second = candidates[1];
      if (
        second &&
        second.score === top.score &&
        top.kind !== "main" &&
        second.kind !== "main"
      ) {
        return {
          ok: false,
          detail: "More than one embedded application frame matched equally, so the executor refused to guess which one is the employer's form.",
        };
      }
      return { ok: true, selection: top };
    }
    await page.waitForTimeout(IFRAME_POLL_MS);
  }

  const reasons = [...rejected.entries()]
    .slice(0, 4)
    .map(([url, reason]) => `${url}: ${reason}`)
    .join(" ");
  return {
    ok: false,
    detail: `No eligible application form was found within ${timeoutMs} ms.${reasons ? ` ${reasons}` : ""}`,
  };
}

function actionFor(scope: FormScope, page: Page, raw: string | null): string {
  try {
    return new URL(raw ?? scope.url(), scope.url()).href;
  } catch {
    return raw ?? page.url();
  }
}

async function explicitEmployerApplyLink(page: Page): Promise<string | null> {
  const hrefs = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll("a"))
        .map((anchor) => ({
          href: anchor.getAttribute("href") ?? "",
          label: (anchor.textContent ?? "").replace(/\s+/g, " ").trim(),
        }))
        .filter((item) => /\b(apply(?: now)?|bewerben|jetzt bewerben|application form|online bewerben)\b/i.test(item.label))
        .map((item) => item.href),
    )
    .catch(() => []);
  const current = page.url();
  for (const href of hrefs) {
    if (!href || href.startsWith("#")) continue;
    try {
      const candidate = new URL(href, current);
      const base = new URL(current);
      if (!/^https?:$/.test(candidate.protocol) || candidate.origin !== base.origin) continue;
      if (candidate.href === current || candidate.pathname === base.pathname) continue;
      if (isAggregatorUrl(candidate.href)) continue;
      assertPublicHttpUrl(candidate.href);
      return candidate.href;
    } catch {
      // Only a valid, public, employer-published link is followed.
    }
  }
  return null;
}

async function visibleValidationErrors(scope: FormScope): Promise<string[]> {
  return scope
    .evaluate(() => {
      const visible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const nodes = Array.from(
        document.querySelectorAll(
          '[role="alert"], [aria-invalid="true"], .error, .error-message, .validation-error, .field-error',
        ),
      ).filter(visible);
      return [...new Set(nodes.map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 4);
    })
    .catch(() => []);
}

function frameEvidence(selection: FrameSelection | null): Record<string, unknown> | null {
  if (!selection) return null;
  return {
    kind: selection.kind,
    url: selection.url,
    origin: selection.origin,
    ancestorOrigins: selection.ancestorOrigins,
    association: selection.association,
  };
}

/**
 * Renders, fills and submits one dynamic application form. The caller keeps the
 * atomic claim, duplicate, reconciliation and daily-cap gates in submission.ts.
 */
export async function runBrowserCandidateForm(input: BrowserFormInput): Promise<BrowserFormRun> {
  const pageUrl = input.pageUrl;
  try {
    assertPublicHttpUrl(pageUrl);
  } catch {
    const plan = planFor({
      pageUrl,
      action: null,
      groups: [],
      questions: [],
      blockers: ["The application page URL is not an allowed public HTTP(S) address."],
      status: "unsupported",
      detail: "The application page URL is not an allowed public HTTP(S) address.",
    });
    return { plan, result: blockedBrowserResult(plan, null) };
  }

  let browser: Browser | null = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: BROWSER_USER_AGENT,
      acceptDownloads: true,
      ignoreHTTPSErrors: false,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(30_000);
    // tsx/esbuild wraps named functions in evaluated callbacks with a `__name`
    // helper. Playwright serialises the callback without that module helper, so
    // provide a no-op in the page world before any evaluate() runs.
    await page.addInitScript("globalThis.__name = globalThis.__name || function (value) { return value; };");

    // Own redirects are followed by the browser, but the arrival URL and any
    // page still need the same SSRF boundary as every other outbound request.
    const guardNavigation = () => {
      try {
        assertPublicHttpUrl(page.url());
      } catch {
        page.goto("about:blank").catch(() => undefined);
      }
    };
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        guardNavigation();
        return;
      }
      // Frame requests are subject to the same public-network boundary. The
      // executor still refuses to interact with a frame that was not selected.
      try {
        if (frame.url() && !frame.url().startsWith("about:")) assertPublicHttpUrl(frame.url());
      } catch {
        // The frame remains unselected; no candidate data is entered into it.
      }
    });

    try {
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });
    } catch (error) {
      const plan = planFor({
        pageUrl,
        action: null,
        groups: [],
        questions: [],
        blockers: ["The application page could not be loaded in the local browser."],
        status: "failed",
        detail: `The application page could not be loaded in the local browser: ${error instanceof Error ? error.message : "navigation error"}. Nothing was sent.`,
      });
      return {
        plan,
        result: {
          status: "failed",
          detail: plan.detail,
          httpStatus: null,
          reference: null,
          endpoint: null,
          finalUrl: pageUrl,
          evidence: { sent: false, executor: "playwright", error: error instanceof Error ? error.message : "navigation error" },
        },
      };
    }

    const security = await visibleSecurityBlocker(page);
    if (security) {
      const plan = planFor({
        pageUrl: page.url(),
        action: null,
        groups: [],
        questions: [],
        blockers: [security],
        status: "security",
        detail: security,
      });
      return { plan, result: blockedBrowserResult(plan, "security_challenge") };
    }

    const allowedHosts = approvedFrameHosts(input.allowedFrameHosts);
    let initialFrame = await waitForApplicationFrame(page, allowedHosts);
    if (!initialFrame.ok) {
      // The employer may publish the real form behind one explicit Apply link.
      // Follow that link only within the verified employer origin; never guess a
      // path and never follow an aggregator.
      const applyLink = await explicitEmployerApplyLink(page);
      if (applyLink) {
        try {
          await page.goto(applyLink, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });
          const linkedSecurity = await visibleSecurityBlocker(page);
          if (linkedSecurity) {
            const plan = planFor({
              pageUrl: page.url(),
              action: applyLink,
              groups: [],
              questions: [],
              blockers: [linkedSecurity],
              status: "security",
              detail: linkedSecurity,
            });
            return { plan, result: blockedBrowserResult(plan, "security_challenge") };
          }
          initialFrame = await waitForApplicationFrame(page, allowedHosts);
        } catch {
          // A failed navigation leaves the original unsupported result.
        }
      }
    }
    if (!initialFrame.ok) {
      const plan = planFor({
        pageUrl: page.url(),
        action: null,
        groups: [],
        questions: [],
        blockers: [initialFrame.detail],
        status: "unsupported",
        detail: `${initialFrame.detail} Nothing was sent.`,
      });
      return { plan, result: blockedBrowserResult(plan, null) };
    }
    let applicationFrame = initialFrame.selection;
    const embeddedSecurity =
      applicationFrame.kind === "main" ? null : await visibleSecurityBlocker(applicationFrame.frame);
    if (embeddedSecurity) {
      const plan = planFor({
        pageUrl: page.url(),
        action: applicationFrame.url,
        groups: [],
        questions: [],
        blockers: [embeddedSecurity],
        status: "security",
        detail: embeddedSecurity,
      });
      return { plan, result: blockedBrowserResult(plan, "security_challenge", applicationFrame) };
    }

    let nextClicks = 0;
    let action: string | null = null;
    let lastGroups: FieldGroup[] = [];
    let lastQuestions: CandidateQuestion[] = [];
    for (let step = 0; step < MAX_STEPS; step += 1) {
      if (step > 0) {
        const refreshed = await waitForApplicationFrame(page, allowedHosts, 5_000);
        if (!refreshed.ok) {
          const plan = planFor({
            pageUrl: page.url(),
            action,
            groups: lastGroups,
            questions: lastQuestions,
            blockers: [refreshed.detail],
            status: "failed",
            detail: `${refreshed.detail} Nothing was sent.`,
          });
          return {
            plan,
            result: {
              status: "failed",
              detail: plan.detail,
              httpStatus: null,
              reference: null,
              endpoint: plan.action,
              finalUrl: page.url(),
              evidence: { sent: false, executor: "playwright", blockers: plan.blockers, questions: lastQuestions },
            },
          };
        }
        applicationFrame = refreshed.selection;
      }

      const stepSecurity =
        (await visibleSecurityBlocker(page)) ??
        (applicationFrame.kind === "main" ? null : await visibleSecurityBlocker(applicationFrame.frame));
      if (stepSecurity) {
        const plan = planFor({
          pageUrl: page.url(),
          action,
          groups: lastGroups,
          questions: lastQuestions,
          blockers: [stepSecurity],
          status: "security",
          detail: stepSecurity,
        });
        return { plan, result: blockedBrowserResult(plan, "security_challenge", applicationFrame) };
      }

      await waitForRenderedControls(applicationFrame.frame);
      const extracted = await extractForm(applicationFrame.frame);
      if (!extracted.fields.some((field) => !field.hidden)) {
        const plan = planFor({
          pageUrl: page.url(),
          action: extracted.action,
          groups: [],
          questions: [],
          blockers: ["The rendered form has no fillable fields."],
          status: "unsupported",
          detail: "The rendered form has no fillable fields; nothing was sent.",
        });
        return { plan, result: blockedBrowserResult(plan, null) };
      }
      // A password control is an access control, never a candidate question.
      // Asking the owner to supply an employer password would be a credential
      // request; stop with a login blocker instead.
      if (extracted.fields.some((field) => field.type === "password")) {
        const detail = "The employer's page requires an account password; credential entry is never automated.";
        const plan = planFor({
          pageUrl: page.url(),
          action,
          groups: [],
          questions: [],
          blockers: [detail],
          status: "intervention",
          detail,
        });
        return { plan, result: blockedBrowserResult(plan, "account_login", applicationFrame) };
      }
      let groups = groupFields(extracted.fields);
      const fieldView = groups.map((group) => group.field);
      const authorised = input.authorised ?? {};
      let questions = fieldView.map((field) =>
        answerFor(categoryFor(field), field, input.profile, input.documents, authorised),
      );
      const uploadIssue = fileUploadBlocker(groups);
      const blockers = [
        ...(uploadIssue ? [uploadIssue] : []),
        ...questions
          .filter((question) => question.action === "intervention")
          .map((question) => `${question.label || question.name}: ${question.reason}`),
      ];
      action = actionFor(applicationFrame.frame, page, extracted.action);
      lastGroups = groups;
      lastQuestions = questions;

      if (blockers.length > 0) {
        const plan = planFor({
          pageUrl: page.url(),
          action,
          groups,
          questions,
          blockers,
        });
        return {
          plan,
          result: blockedBrowserResult(plan, externalRequirementFor(questions, null), applicationFrame),
        };
      }

      for (const [index, group] of groups.entries()) {
        const question = questions[index];
        const fillError = await fillField(applicationFrame.frame, group, question, input.documents);
        if (fillError) {
          const plan = planFor({
            pageUrl: page.url(),
            action,
            groups,
            questions,
            blockers: [fillError],
            status: "failed",
            detail: `${fillError} Nothing was sent.`,
          });
          return {
            plan,
            result: {
              status: "failed",
              detail: plan.detail,
              httpStatus: null,
              reference: null,
              endpoint: plan.action,
              finalUrl: page.url(),
              evidence: { sent: false, executor: "playwright", blockers: plan.blockers, questions },
            },
          };
        }
        const verifyError = await verifyField(applicationFrame.frame, group, question);
        if (verifyError) {
          const plan = planFor({
            pageUrl: page.url(),
            action,
            groups,
            questions,
            blockers: [verifyError],
            status: "failed",
            detail: `${verifyError} Nothing was sent.`,
          });
          return {
            plan,
            result: {
              status: "failed",
              detail: plan.detail,
              httpStatus: null,
              reference: null,
              endpoint: plan.action,
              finalUrl: page.url(),
              evidence: { sent: false, executor: "playwright", blockers: plan.blockers, questions },
            },
          };
        }
      }

      // Conditional questions can be revealed after a select, checkbox or file
      // upload. Re-scan once and fill only fields that were not present before,
      // so a newly required question is never submitted empty.
      const knownKeys = () => new Set(groups.map((group) => `${group.kind}:${group.field.name}`));
      const newlyRevealed = (candidate: ExtractedForm): FieldGroup[] => {
        const known = knownKeys();
        return groupFields(candidate.fields).filter(
          (group) => !known.has(`${group.kind}:${group.field.name}`),
        );
      };
      let revealed = await extractForm(applicationFrame.frame);
      let revealedGroups = newlyRevealed(revealed);
      for (let attempt = 0; attempt < 5 && revealedGroups.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        revealed = await extractForm(applicationFrame.frame);
        revealedGroups = newlyRevealed(revealed);
      }
      if (revealedGroups.length > 0) {
        const revealedQuestions = revealedGroups.map((group) =>
          answerFor(categoryFor(group.field), group.field, input.profile, input.documents, authorised),
        );
        const revealedBlockers = [
          ...(fileUploadBlocker(revealedGroups) ? [fileUploadBlocker(revealedGroups) as string] : []),
          ...revealedQuestions
            .filter((question) => question.action === "intervention")
            .map((question) => `${question.label || question.name}: ${question.reason}`),
        ];
        groups = [...groups, ...revealedGroups];
        questions = [...questions, ...revealedQuestions];
        lastGroups = groups;
        lastQuestions = questions;
        if (revealedBlockers.length > 0) {
          const plan = planFor({
            pageUrl: page.url(),
            action,
            groups,
            questions,
            blockers: revealedBlockers,
          });
          return {
            plan,
            result: blockedBrowserResult(plan, externalRequirementFor(revealedQuestions, null), applicationFrame),
          };
        }
        for (const [index, group] of revealedGroups.entries()) {
          const question = revealedQuestions[index];
          const fillError = await fillField(applicationFrame.frame, group, question, input.documents);
          const verifyError = fillError
            ? null
            : await verifyField(applicationFrame.frame, group, question);
          const error = fillError ?? verifyError;
          if (error) {
            const plan = planFor({
              pageUrl: page.url(),
              action,
              groups,
              questions,
              blockers: [error],
              status: "failed",
              detail: `${error} Nothing was sent.`,
            });
            return {
              plan,
              result: {
                status: "failed",
                detail: plan.detail,
                httpStatus: null,
                reference: null,
                endpoint: plan.action,
                finalUrl: page.url(),
                evidence: { sent: false, executor: "playwright", blockers: plan.blockers, questions },
              },
            };
          }
        }
      }

      if (input.probeOnly) {
        // Hard stop before any submit/next control. This is the only code path
        // that may run with probeOnly=true, and it returns unconditionally.
        let screenshot: string | null = null;
        if (input.screenshotPath) {
          try {
            await page.screenshot({ path: input.screenshotPath, fullPage: true });
            screenshot = input.screenshotPath;
          } catch {
            screenshot = null;
          }
        }
        const filledFields = questions.filter((question) => question.action === "answer").map((question) => question.name);
        const probe: BrowserFormProbe = {
          executor: "playwright",
          pageUrl,
          finalUrl: applicationFrame.frame.url() || page.url(),
          formFound: true,
          fields: groups.length,
          filledFields,
          submit: extracted.submit,
          applicationFrame: frameEvidence(applicationFrame),
          screenshot,
        };
        const plan = planFor({ pageUrl: page.url(), action, groups, questions, blockers: [] });
        return {
          plan,
          probe,
          result: {
            status: "blocked",
            detail: `Probe only: the rendered form was detected, ${filledFields.length} field(s) were filled and verified, and no submit control was activated. Nothing was sent.`,
            httpStatus: null,
            reference: null,
            endpoint: action,
            finalUrl: probe.finalUrl,
            evidence: { sent: false, executor: "playwright", probeOnly: true, blockers: [], questions },
          },
        };
      }

      const submit = extracted.submit;
      // A CAPTCHA is an access control even when its widget is visually hidden
      // until the final click (invisible reCAPTCHA). Presence in the DOM is
      // enough to stop before the send control is activated.
      const captchaPresent = await applicationFrame.frame
        .evaluate(() =>
          Boolean(
            document.querySelector(
              'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], .g-recaptcha, .h-captcha, [data-sitekey]',
            ),
          ),
        )
        .catch(() => false);
      if (captchaPresent) {
        const detail = "The application form contains a CAPTCHA, which is never bypassed.";
        const plan = planFor({
          pageUrl: page.url(),
          action,
          groups,
          questions,
          blockers: [detail],
          status: "security",
          detail,
        });
        return { plan, result: blockedBrowserResult(plan, "security_challenge", applicationFrame) };
      }
      if (!submit) {
        const plan = planFor({
          pageUrl: page.url(),
          action,
          groups,
          questions,
          blockers: ["The rendered form has no visible submit control."],
          status: "failed",
          detail: "The rendered form has no visible submit control; nothing was sent.",
        });
        return {
          plan,
          result: {
            status: "failed",
            detail: plan.detail,
            httpStatus: null,
            reference: null,
            endpoint: plan.action,
            finalUrl: page.url(),
            evidence: { sent: false, executor: "playwright", blockers: plan.blockers, questions },
          },
        };
      }

      if (submit.kind === "next" && nextClicks < MAX_STEPS - 1) {
        nextClicks += 1;
        try {
          await applicationFrame.frame.locator(submit.selector).first().click({ timeout: 15_000 });
          await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
          await applicationFrame.frame.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
          await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
          await page.waitForTimeout(250);
          const validation = await visibleValidationErrors(applicationFrame.frame);
          if (validation.length > 0) {
            const detail = `The form rejected the step: ${validation.join(" ")}`;
            const plan = planFor({
              pageUrl: page.url(),
              action,
              groups,
              questions,
              blockers: validation,
              status: "failed",
              detail: `${detail} Nothing was sent.`,
            });
            return {
              plan,
              result: {
                status: "failed",
                detail: plan.detail,
                httpStatus: null,
                reference: null,
                endpoint: plan.action,
                finalUrl: applicationFrame.frame.url(),
                evidence: {
                  sent: false,
                  executor: "playwright",
                  blockers: plan.blockers,
                  questions,
                  applicationFrame: frameEvidence(applicationFrame),
                },
              },
            };
          }
        } catch (error) {
          const plan = planFor({
            pageUrl: page.url(),
            action,
            groups,
            questions,
            blockers: ["The form's next step could not be completed."],
            status: "failed",
            detail: `The form's next step could not be completed: ${error instanceof Error ? error.message : "navigation error"}. Nothing was sent.`,
          });
          return {
            plan,
            result: {
              status: "failed",
              detail: plan.detail,
              httpStatus: null,
              reference: null,
              endpoint: plan.action,
              finalUrl: page.url(),
              evidence: { sent: false, executor: "playwright", blockers: plan.blockers, questions },
            },
          };
        }
        continue;
      }

      // The final submit click. A response listener runs before the click so a
      // fast client-side POST is never missed.
      let httpStatus: number | null = null;
      let response: { status(): number } | null = null;
      const responsePromise = page
        .waitForResponse((candidate) => ["POST", "PUT", "PATCH"].includes(candidate.request().method()), {
          timeout: 25_000,
        })
        .catch(() => null);
      try {
        await applicationFrame.frame.locator(submit.selector).first().click({ timeout: 15_000 });
        response = await responsePromise;
        httpStatus = response?.status() ?? null;
        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
        await applicationFrame.frame.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      } catch (error) {
        const plan = planFor({
          pageUrl: page.url(),
          action,
          groups,
          questions,
          blockers: ["The submit control could not be activated."],
          status: "failed",
          detail: `The submit control could not be activated: ${error instanceof Error ? error.message : "submit error"}. Nothing was sent.`,
        });
        return {
          plan,
          result: {
            status: "failed",
            detail: plan.detail,
            httpStatus,
            reference: null,
            endpoint: plan.action,
            finalUrl: page.url(),
            evidence: { sent: false, executor: "playwright", blockers: plan.blockers, questions },
          },
        };
      }

      const finalUrl = applicationFrame.frame.url() || page.url();
      const pageHtml = await page.content().catch(() => "");
      const frameHtml = await applicationFrame.frame.content().catch(() => "");
      const pageText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
      const frameText =
        applicationFrame.kind === "main"
          ? ""
          : await applicationFrame.frame.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
      const html = `${pageHtml} ${frameHtml}`;
      const text = `${pageText} ${frameText}`.trim();
      const plan = planFor({
        pageUrl,
        action,
        groups,
        questions,
        blockers: [],
      });
      const evidenceBase = {
        executor: "playwright",
        finalUrl,
        httpStatus,
        questions,
        filledFields: questions.filter((question) => question.action === "answer").map((question) => question.name),
        files: [input.documents.cv?.name, input.documents.cover?.name].filter(Boolean),
        steps: step + 1,
        applicationFrame: frameEvidence(applicationFrame),
      };

      if (httpStatus !== null && httpStatus >= 400) {
        const ambiguous = httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
        return {
          plan,
          result: {
            status: ambiguous ? "failed" : "rejected",
            detail: ambiguous
              ? `The employer's form returned HTTP ${httpStatus}; delivery is unknown and will not be retried blindly.`
              : `The employer's form rejected the application with HTTP ${httpStatus}. Nothing was recorded as submitted.`,
            httpStatus,
            reference: null,
            endpoint: plan.action,
            finalUrl,
            evidence: { ...evidenceBase, sent: true, responseSnippet: text.slice(0, 800) },
          },
        };
      }

      const classified = classifySuccess(`${html} ${text}`, finalUrl, httpStatus ?? 200);
      if (classified.status === "verified") {
        return {
          plan,
          result: {
            status: "verified",
            detail: classified.detail,
            httpStatus,
            reference: classified.reference,
            endpoint: plan.action,
            finalUrl,
            evidence: {
              ...evidenceBase,
              sent: true,
              confirmation: classified.confirmation,
              reference: classified.reference,
              responseSnippet: text.slice(0, 1200),
            },
          },
        };
      }

      const afterSecurity =
        (await visibleSecurityBlocker(page)) ??
        (applicationFrame.kind === "main" ? null : await visibleSecurityBlocker(applicationFrame.frame));
      if (afterSecurity) {
        return {
          plan,
          result: blockedBrowserResult(
            { ...plan, detail: afterSecurity, blockers: [afterSecurity] },
            "security_challenge",
            applicationFrame,
          ),
        };
      }

      if (!response) {
        const clientErrors = await visibleValidationErrors(applicationFrame.frame);
        if (clientErrors.length > 0) {
          return {
            plan,
            result: {
              status: "failed",
              detail: `The form rejected the application: ${clientErrors.join(" ")} Nothing was sent.`,
              httpStatus,
              reference: null,
              endpoint: plan.action,
              finalUrl,
              evidence: {
                ...evidenceBase,
                sent: null,
                blockers: clientErrors,
                responseSnippet: text.slice(0, 800),
              },
            },
          };
        }
        return {
          plan,
          result: {
            status: "failed",
            detail: "The submit control was clicked but no submission request was observed; nothing was confirmed and no retry is attempted.",
            httpStatus,
            reference: null,
            endpoint: plan.action,
            finalUrl,
            evidence: { ...evidenceBase, sent: null, responseSnippet: text.slice(0, 800) },
          },
        };
      }

      return {
        plan,
        result: {
          status: "unverified",
          detail: classified.detail,
          httpStatus,
          reference: classified.reference,
          endpoint: plan.action,
          finalUrl,
          evidence: {
            ...evidenceBase,
            sent: true,
            confirmation: classified.confirmation,
            reference: classified.reference,
            responseSnippet: text.slice(0, 1200),
          },
        },
      };
    }

    const plan = planFor({
      pageUrl: page.url(),
      action,
      groups: lastGroups,
      questions: lastQuestions,
      blockers: [`The form required more than ${MAX_STEPS} steps.`],
      status: "unsupported",
      detail: `The form required more than ${MAX_STEPS} steps; nothing was sent.`,
    });
    return { plan, result: blockedBrowserResult(plan, null, applicationFrame) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown browser error";
    const unavailable = /browserType\.launch|Executable doesn't exist|playwright|Cannot find module/i.test(message);
    const plan = planFor({
      pageUrl,
      action: null,
      groups: [],
      questions: [],
      blockers: [unavailable ? "The local Playwright browser executor is unavailable." : "The local browser executor failed."],
      status: "failed",
      detail: unavailable
        ? `The local Playwright browser executor is unavailable: ${message}. Nothing was sent.`
        : `The local browser executor failed: ${message}. Nothing was sent.`,
    });
    return {
      plan,
      result: {
        status: "failed",
        detail: plan.detail,
        httpStatus: null,
        reference: null,
        endpoint: null,
        finalUrl: pageUrl,
        evidence: { sent: false, executor: "playwright", browserAvailable: !unavailable, error: message },
      },
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
