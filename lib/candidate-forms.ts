/**
 * Candidate-facing application forms.
 *
 * This is deliberately separate from employer-side ATS APIs. It reads a normal
 * public application page, maps the visible fields to facts the owner has
 * verified, and posts the form as a candidate would. It never solves a CAPTCHA,
 * enters credentials, bypasses MFA, pays a fee, or pretends a form was submitted
 * when the response did not confirm it.
 *
 * The implementation intentionally handles server-rendered forms only. A form
 * that requires JavaScript, an account login or a security challenge is queued
 * for human intervention rather than driven through a browser.
 */

export type CandidateField = {
  name: string;
  label: string;
  type: string;
  required: boolean;
  options: Array<{ value: string; label: string }>;
  hidden: boolean;
  accept: string | null;
  /** Preserved value for hidden inputs (CSRF tokens, form ids). */
  value: string | null;
};

export type CandidateQuestion = {
  name: string;
  label: string;
  required: boolean;
  category: string;
  action: "answer" | "blank" | "intervention";
  answer: string | null;
  consequential: boolean;
  reason: string;
};

export type CandidateProfile = {
  fullName: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedin: string | null;
  website: string | null;
  workAuthorisation: string | null;
  summary: string | null;
  skills: string[];
  languages: string[];
  experienceText: string | null;
  educationText: string | null;
  sponsorshipAnswer: string | null;
};

export type CandidateDocuments = {
  cv: { buffer: Buffer; name: string } | null;
  cover: { buffer: Buffer; name: string } | null;
  coverText: string | null;
};

export type CandidateFormPlan = {
  status: "ready" | "intervention" | "security" | "unsupported" | "failed";
  detail: string;
  pageUrl: string;
  action: string | null;
  method: string;
  fields: CandidateField[];
  questions: CandidateQuestion[];
  blockers: string[];
  cookies: string | null;
};

export type CandidateFormResult = {
  status: "verified" | "unverified" | "rejected" | "failed" | "blocked";
  detail: string;
  httpStatus: number | null;
  reference: string | null;
  endpoint: string | null;
  finalUrl: string | null;
  evidence: Record<string, unknown>;
};

type FetchLike = typeof fetch;

const SECURITY_PATTERNS: Array<[RegExp, string]> = [
  [/recaptcha|hcaptcha|i['’]m not a robot|i am not a robot|captcha/i, "The application form contains a CAPTCHA, which is never bypassed."],
  [/multi[- ]factor|two[- ]factor|2fa|verification code|authenticator app/i, "The application process requires multi-factor authentication."],
  [/sign in to apply|log in to apply|login to apply|create an account to apply|already have an account\? sign in/i, "The employer requires an account login before applying."],
  [/cloudflare|attention required|checking your browser|verify you are human/i, "A browser security challenge blocks automated completion."],
  [/application fee|pay to apply|paid application|processing fee/i, "The application requires a payment, which is never made."],
];

const SUCCESS_PATTERNS = [
  /application (?:has been |was )?(?:successfully )?(?:submitted|received|sent)/i,
  /thank you for (?:your application|applying|your interest)/i,
  /we(?:['’]ve| have) received your application/i,
  /your application (?:is|was) (?:complete|received|submitted)/i,
  /bewerbung (?:wurde )?erfolgreich/i,
  /application complete/i,
];

const SUCCESS_PATH = /(?:thank[-_]?you|success|confirmation|confirmed|applied|application[-_]?received)/i;

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of tag.matchAll(re)) {
    out[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return out;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

function detectSecurity(html: string): string | null {
  for (const [pattern, message] of SECURITY_PATTERNS) if (pattern.test(html)) return message;
  return null;
}

function parseForms(html: string): Array<{ attrs: Record<string, string>; body: string }> {
  const forms: Array<{ attrs: Record<string, string>; body: string }> = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  for (const match of html.matchAll(re)) {
    forms.push({ attrs: attributes(match[1]), body: match[2] });
  }
  return forms;
}

function parseFields(formHtml: string): CandidateField[] {
  const labelById = new Map<string, string>();
  for (const match of formHtml.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const attrs = attributes(match[1]);
    const text = stripTags(match[2]);
    if (attrs.for && text) labelById.set(attrs.for, text);
  }

  const fields: CandidateField[] = [];
  const seenRadio = new Set<string>();

  const add = (attrs: Record<string, string>, fallbackType: string, closingLabel = "") => {
    const name = (attrs.name ?? "").trim();
    const type = (attrs.type ?? fallbackType).toLowerCase();
    if (!name || ["submit", "button", "reset", "image"].includes(type)) return;
    if ((type === "radio" || type === "checkbox") && seenRadio.has(`${type}:${name}`)) return;
    const id = attrs.id ?? "";
    const label = labelById.get(id) ?? (closingLabel || attrs["aria-label"] || attrs.placeholder || name);
    const optionValue = attrs.value ?? "on";
    const options =
      type === "checkbox" || type === "radio"
        ? [{ value: optionValue, label: label || optionValue }]
        : [];
    fields.push({
      name,
      label: stripTags(label),
      type,
      required: "required" in attrs || attrs["aria-required"] === "true",
      options,
      hidden: type === "hidden",
      accept: attrs.accept ?? null,
      value: attrs.value ?? null,
    });
    if (type === "radio" || type === "checkbox") seenRadio.add(`${type}:${name}`);
  };

  // Inputs. A wrapped label's text is the fragment immediately before the tag.
  for (const match of formHtml.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = attributes(match[1]);
    const before = formHtml.slice(Math.max(0, (match.index ?? 0) - 350), match.index ?? 0);
    const openLabel = before.match(/<label\b[^>]*>([^<]*)$/i);
    add(attrs, "text", openLabel ? stripTags(openLabel[1]) : "");
  }

  for (const match of formHtml.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const attrs = attributes(match[1]);
    if (!attrs.name) continue;
    const label = labelById.get(attrs.id ?? "") ?? attrs["aria-label"] ?? attrs.placeholder ?? attrs.name;
    fields.push({
      name: attrs.name,
      label: stripTags(label),
      type: "textarea",
      required: "required" in attrs || attrs["aria-required"] === "true",
      options: [],
      hidden: false,
      accept: null,
      value: null,
    });
    void match[2];
  }

  for (const match of formHtml.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const attrs = attributes(match[1]);
    if (!attrs.name) continue;
    const options: Array<{ value: string; label: string }> = [];
    for (const option of match[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
      const optionAttrs = attributes(option[1]);
      options.push({ value: decodeEntities(optionAttrs.value ?? ""), label: stripTags(option[2]) });
    }
    fields.push({
      name: attrs.name,
      label: stripTags(labelById.get(attrs.id ?? "") ?? attrs["aria-label"] ?? attrs.name),
      type: "select",
      required: "required" in attrs || attrs["aria-required"] === "true",
      options,
      hidden: false,
      accept: null,
      value: null,
    });
  }

  return fields;
}

function categoryFor(field: CandidateField): string {
  const text = normalise(`${field.name} ${field.label} ${field.type} ${field.accept ?? ""}`);
  if (field.type === "file") {
    if (/cover|motivation|anschreiben/.test(text)) return "cover_file";
    if (/resume|curriculum|\bcv\b|lebenslauf|attachment|upload/.test(text)) return "cv_file";
    return "unknown_file";
  }
  if (/salary|compensation|remuneration|desired pay|gehalt|pay expectation/.test(text)) return "salary";
  if (/relocat|willing to move|willingness to relocate|umzug/.test(text)) return "relocation";
  if (/notice period|earliest start|available to start|start date|availability|kuendigungsfrist|kündigungsfrist/.test(text)) return "notice";
  if (/first name|given name|vorname/.test(text)) return "first_name";
  if (/last name|surname|family name|nachname/.test(text)) return "last_name";
  if (/full name|your name|legal name|complete name|^name$|\bname\b/.test(text)) return "full_name";
  if (/e-?mail/.test(text)) return "email";
  if (/phone|mobile|telephone|telefon/.test(text)) return "phone";
  if (/linkedin/.test(text)) return "linkedin";
  if (/website|portfolio|github|url/.test(text)) return "website";
  if (/sponsor/.test(text)) return "sponsorship";
  if (/work authori|right to work|authori[sz]ed to work|work permit|visa status|arbeitsbewilligung/.test(text)) return "work_authorisation";
  if (/current location|city|town|where.*based|address|wohnort/.test(text)) return "location";
  if (/cover letter|motivation letter|anschreiben/.test(text)) return "cover_text";
  if (/education|degree|qualification|academic|ausbildung/.test(text)) return "education";
  if (/experience|employment history|work history|berufserfahrung/.test(text)) return "experience";
  if (/skills|technolog|competenc|kenntnisse/.test(text)) return "skills";
  if (/language|sprache/.test(text)) return "languages";
  if (/legal|declare|certif|attest|terms|privacy|consent|gdpr|background check|truthful|accurate|confirm that/.test(text)) return "legal";
  if (/summary|about you|profile|message|comments/.test(text)) return "summary";
  if (/how did you hear|source|referr/.test(text)) return "referral";
  return "unknown";
}

function authorisedValue(authorised: Record<string, string>, category: string): string | null {
  const aliases: Record<string, string[]> = {
    salary: ["salary", "salary_expectation", "expected_salary"],
    notice: ["notice", "notice_period", "availability"],
    relocation: ["relocation", "willing_to_relocate"],
    legal: ["legal", "legal_declaration", "declaration"],
  };
  for (const key of aliases[category] ?? [category]) {
    const value = authorised[key];
    if (value?.trim()) return value.trim();
  }
  return null;
}

function matchOption(field: CandidateField, answer: string): string | null {
  const wanted = normalise(answer);
  const direct = field.options.find(
    (option) => normalise(option.value) === wanted || normalise(option.label) === wanted,
  );
  if (direct) return direct.value;
  if (/^(yes|true|y)$/.test(wanted)) {
    const yes = field.options.find((option) => /^(yes|true|y|ja)\b/i.test(option.label) || /^(yes|true|y|ja)$/i.test(option.value));
    if (yes) return yes.value;
  }
  if (/^(no|false|n)$/.test(wanted)) {
    const no = field.options.find((option) => /^(no|false|n|nein)\b/i.test(option.label) || /^(no|false|n|nein)$/i.test(option.value));
    if (no) return no.value;
  }
  return null;
}

function answerFor(
  category: string,
  field: CandidateField,
  profile: CandidateProfile,
  documents: CandidateDocuments,
  authorised: Record<string, string>,
): CandidateQuestion {
  const base = {
    name: field.name,
    label: field.label,
    required: field.required,
    category,
    answer: null as string | null,
    consequential: false,
  };
  const intervention = (reason: string, consequential = false): CandidateQuestion => ({
    ...base,
    action: "intervention",
    consequential,
    reason,
  });
  const answer = (value: string | null | undefined, reason: string): CandidateQuestion => {
    if (value === null || value === undefined || !String(value).trim()) {
      return field.required
        ? intervention("This required answer is not present in the verified profile.")
        : { ...base, action: "blank", reason: `${reason} No verified value is available; the optional field is left blank.` };
    }
    if (field.options.length > 0) {
      const selected = matchOption(field, String(value));
      if (!selected) return intervention(`No option on the form matches the verified answer "${value}".`);
      return { ...base, action: "answer", answer: selected, reason };
    }
    return { ...base, action: "answer", answer: String(value), reason };
  };

  if (["salary", "notice", "relocation", "legal"].includes(category)) {
    const allowed = authorisedValue(authorised, category);
    if (allowed) return answer(allowed, "Previously authorised answer supplied by the owner.");
    const message =
      category === "salary"
        ? "Salary expectations are consequential and have not been authorised."
        : category === "notice"
          ? "The notice period is unknown and has not been authorised."
          : category === "relocation"
            ? "Willingness to relocate is a personal decision and has not been authorised."
            : "This is a legal declaration that requires the owner's explicit confirmation.";
    return intervention(message, true);
  }

  switch (category) {
    case "first_name":
      return answer(profile.fullName?.trim().split(/\s+/)[0] ?? null, "First name from the verified profile.");
    case "last_name":
      return answer(profile.fullName?.trim().split(/\s+/).slice(1).join(" ") || null, "Last name from the verified profile.");
    case "full_name":
      return answer(profile.fullName, "Full name from the verified profile.");
    case "email":
      return answer(profile.email, "Email from the verified profile.");
    case "phone":
      return answer(profile.phone, "Phone from the verified profile.");
    case "linkedin":
      return answer(profile.linkedin, "LinkedIn URL from the verified profile.");
    case "website":
      return answer(profile.website, "Website from the verified profile.");
    case "work_authorisation":
      return answer(profile.workAuthorisation, "Work authorisation recorded in the verified profile.");
    case "sponsorship":
      return answer(
        profile.sponsorshipAnswer,
        "Sponsorship answer derived from the verified Swiss work authorisation.",
      );
    case "location":
      return answer(profile.location, "Location from the verified profile.");
    case "cover_text":
      return answer(documents.coverText, "Generated cover letter text, checked against verified facts.");
    case "summary":
      return answer(profile.summary, "Professional summary from the verified profile.");
    case "skills":
      return answer(profile.skills.join(", "), "Skills from the verified profile.");
    case "languages":
      return answer(profile.languages.join(", "), "Languages from the verified profile.");
    case "experience":
      return answer(profile.experienceText, "Employment history from the verified profile.");
    case "education":
      return answer(profile.educationText, "Education from the verified profile.");
    case "cv_file":
      return answer(documents.cv ? documents.cv.name : null, "Tailored CV file.");
    case "cover_file":
      return answer(documents.cover ? documents.cover.name : null, "Generated cover letter file.");
    case "referral":
      return { ...base, action: "blank", reason: "Optional referral source is not verified; left blank." };
    default:
      return field.required
        ? intervention("This required question is not covered by verified profile data.")
        : { ...base, action: "blank", reason: "Optional unknown field left blank." };
  }
}

function cookieHeader(response: Response): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [];
  const cookies = values
    .map((value) => value.split(";")[0]?.trim())
    .filter((value): value is string => Boolean(value));
  return cookies.length ? cookies.join("; ") : null;
}

function absolute(raw: string, pageUrl: string): string | null {
  try {
    const url = new URL(raw, pageUrl);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export async function prepareCandidateForm(input: {
  pageUrl: string;
  jobTitle: string;
  company: string;
  profile: CandidateProfile;
  documents: CandidateDocuments;
  authorised?: Record<string, string>;
  fetchImpl?: FetchLike;
}): Promise<CandidateFormPlan> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const empty: CandidateFormPlan = {
    status: "failed",
    detail: "The application form could not be read.",
    pageUrl: input.pageUrl,
    action: null,
    method: "post",
    fields: [],
    questions: [],
    blockers: [],
    cookies: null,
  };
  let response: Response;
  try {
    response = await fetchImpl(input.pageUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "AT-AI-Workforce/2.6 (candidate application form)",
      },
      cache: "no-store",
    });
  } catch (error) {
    return { ...empty, detail: `The application page could not be loaded: ${error instanceof Error ? error.message : "network error"}.` };
  }
  const html = (await response.text().catch(() => "")).slice(0, 250_000);
  const security = detectSecurity(html);
  if (security) return { ...empty, status: "security", detail: security, blockers: [security] };
  if (!response.ok) {
    return {
      ...empty,
      status: "unsupported",
      detail: `The application page returned HTTP ${response.status}, so nothing was completed.`,
      blockers: [`Application page returned HTTP ${response.status}.`],
    };
  }

  const forms = parseForms(html);
  if (forms.length === 0) {
    return {
      ...empty,
      status: "unsupported",
      detail: "No server-rendered application form was found. The employer may require JavaScript or an account.",
      blockers: ["No server-rendered application form was found."],
    };
  }
  const form =
    forms.find((candidate) => /<input[^>]+type=["']?file/i.test(candidate.body)) ??
    forms.find((candidate) => /apply|application|bewerb/i.test(`${candidate.attrs.id ?? ""} ${candidate.attrs.class ?? ""} ${candidate.attrs.action ?? ""}`)) ??
    forms[0];
  const method = (form.attrs.method ?? "post").toLowerCase();
  if (method !== "post") {
    return {
      ...empty,
      status: "unsupported",
      detail: "The application form does not use a POST submission, which this safe workflow does not automate.",
      blockers: ["Unsupported form method."],
    };
  }
  const action = absolute(form.attrs.action || input.pageUrl, input.pageUrl);
  if (!action) {
    return { ...empty, status: "unsupported", detail: "The application form has no usable http(s) action URL.", blockers: ["No usable form action."] };
  }

  const fields = parseFields(form.body);
  const authorised = input.authorised ?? {};
  const questions = fields
    .filter((field) => field.name !== "_charset_")
    .map((field) => answerFor(categoryFor(field), field, input.profile, input.documents, authorised));
  const blockers = questions
    .filter((question) => question.action === "intervention")
    .map((question) => `${question.label || question.name}: ${question.reason}`);

  return {
    status: blockers.length > 0 ? "intervention" : "ready",
    detail:
      blockers.length > 0
        ? `${blockers.length} essential question(s) cannot be answered from verified information.`
        : `Form ready: ${questions.filter((question) => question.action === "answer").length} verified answer(s), ${questions.filter((question) => question.action === "blank").length} optional field(s) left blank.`,
    pageUrl: input.pageUrl,
    action,
    method,
    fields,
    questions,
    blockers,
    cookies: cookieHeader(response),
  };
}

function extractReference(text: string): string | null {
  const match = text.match(
    /(?:application|confirmation|reference|candidate)\s*(?:reference|number|no\.?|id|#)?\s*[:#-]\s*([A-Z0-9][A-Z0-9._-]{2,40})/i,
  ) ?? text.match(/\b(?:ref|reference|confirmation)\s*(?:number|no\.?|id)?\s*[:#]\s*([A-Z0-9][A-Z0-9._-]{3,40})/i);
  return match?.[1]?.trim() ?? null;
}

function classifySuccess(text: string, finalUrl: string, httpStatus: number): {
  status: "verified" | "unverified";
  detail: string;
  reference: string | null;
  confirmation: string | null;
} {
  const clean = stripTags(text);
  const reference = extractReference(clean);
  const confirmation = SUCCESS_PATTERNS.map((pattern) => clean.match(pattern)?.[0]).find(Boolean) ?? null;
  const successPath = SUCCESS_PATH.test(finalUrl);
  if (confirmation || (successPath && httpStatus >= 200 && httpStatus < 300)) {
    return {
      status: "verified",
      detail: confirmation
        ? `The employer's form confirmed the application${reference ? ` with reference ${reference}` : ""}.`
        : `The application reached a verified confirmation page${reference ? ` with reference ${reference}` : ""}.`,
      reference,
      confirmation,
    };
  }
  return {
    status: "unverified",
    detail: "The form returned a response but no explicit confirmation or reference, so the submission is unverified.",
    reference,
    confirmation: null,
  };
}

export async function submitCandidateForm(input: {
  plan: CandidateFormPlan;
  documents: CandidateDocuments;
  fetchImpl?: FetchLike;
}): Promise<CandidateFormResult> {
  const { plan } = input;
  if (plan.status === "intervention") {
    return {
      status: "blocked",
      detail: plan.detail,
      httpStatus: null,
      reference: null,
      endpoint: plan.action,
      finalUrl: plan.pageUrl,
      evidence: { questions: plan.questions, blockers: plan.blockers, sent: false },
    };
  }
  if (plan.status !== "ready" || !plan.action) {
    return {
      status: "blocked",
      detail: plan.detail,
      httpStatus: null,
      reference: null,
      endpoint: plan.action,
      finalUrl: plan.pageUrl,
      evidence: { blockers: plan.blockers, sent: false },
    };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const form = new FormData();
  const decisions = new Map(plan.questions.map((question) => [question.name, question]));
  for (const field of plan.fields) {
    const decision = decisions.get(field.name);
    if (field.type === "file") {
      if (field.hidden) {
        const hidden = form.get(field.name);
        void hidden;
      }
      const file = decision?.category === "cover_file" ? input.documents.cover : input.documents.cv;
      if (file) {
        form.set(
          field.name,
          new Blob([new Uint8Array(file.buffer)], { type: "application/pdf" }),
          file.name,
        );
      }
      continue;
    }
    if (field.hidden) {
      if (field.value !== null) form.set(field.name, field.value);
      continue;
    }
    if (field.type === "checkbox" || field.type === "radio") {
      if (decision?.action === "answer" && decision.answer) form.set(field.name, decision.answer);
      continue;
    }
    if (decision?.action === "answer" && decision.answer !== null) form.set(field.name, decision.answer);
  }

  const headers: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": "AT-AI-Workforce/2.6 (candidate application form)",
  };
  if (plan.cookies) headers.Cookie = plan.cookies;

  let httpStatus: number | null = null;
  let finalUrl = plan.action;
  try {
    let response = await fetchImpl(plan.action, {
      method: "POST",
      body: form,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(45_000),
      cache: "no-store",
    });
    httpStatus = response.status;
    let text = (await response.text().catch(() => "")).slice(0, 60_000);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const target = location ? absolute(location, plan.action) : null;
      if (!target) {
        return {
          status: "unverified",
          detail: "The form redirected but no confirmation page could be read, so delivery is unverified.",
          httpStatus,
          reference: null,
          endpoint: plan.action,
          finalUrl,
          evidence: { httpStatus, questions: plan.questions, files: [input.documents.cv?.name, input.documents.cover?.name].filter(Boolean) },
        };
      }
      finalUrl = target;
      try {
        const follow = await fetchImpl(target, {
          redirect: "follow",
          headers,
          signal: AbortSignal.timeout(30_000),
          cache: "no-store",
        });
        httpStatus = follow.status;
        text = (await follow.text().catch(() => "")).slice(0, 60_000);
        finalUrl = follow.url || target;
      } catch (error) {
        return {
          status: "unverified",
          detail: `The form accepted the POST but the confirmation page could not be loaded (${error instanceof Error ? error.message : "network error"}). Delivery is unverified.`,
          httpStatus,
          reference: null,
          endpoint: plan.action,
          finalUrl,
          evidence: { httpStatus, redirectTo: target, questions: plan.questions },
        };
      }
    }

    const security = detectSecurity(text);
    if (security) {
      return {
        status: "blocked",
        detail: security,
        httpStatus,
        reference: null,
        endpoint: plan.action,
        finalUrl,
        evidence: { httpStatus, security, questions: plan.questions },
      };
    }

    if (httpStatus !== null && httpStatus >= 400) {
      const ambiguous = httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
      return {
        status: ambiguous ? "failed" : "rejected",
        detail: ambiguous
          ? `The form returned HTTP ${httpStatus}; delivery is unknown and will not be retried blindly.`
          : `The form rejected the application with HTTP ${httpStatus}. Nothing was recorded as submitted.`,
        httpStatus,
        reference: null,
        endpoint: plan.action,
        finalUrl,
        evidence: {
          httpStatus,
          responseSnippet: stripTags(text).slice(0, 800),
          questions: plan.questions,
          files: [input.documents.cv?.name, input.documents.cover?.name].filter(Boolean),
        },
      };
    }

    const classified = classifySuccess(text, finalUrl, httpStatus ?? 200);
    return {
      status: classified.status,
      detail: classified.detail,
      httpStatus,
      reference: classified.reference,
      endpoint: plan.action,
      finalUrl,
      evidence: {
        httpStatus,
        finalUrl,
        confirmation: classified.confirmation,
        reference: classified.reference,
        responseSnippet: stripTags(text).slice(0, 1200),
        questions: plan.questions,
        files: [input.documents.cv?.name, input.documents.cover?.name].filter(Boolean),
      },
    };
  } catch (error) {
    return {
      status: "failed",
      detail: `The form submission failed: ${error instanceof Error ? error.message : "unknown transport error"}. Delivery is unknown.`,
      httpStatus,
      reference: null,
      endpoint: plan.action,
      finalUrl,
      evidence: { httpStatus, error: error instanceof Error ? error.message : "unknown", questions: plan.questions },
    };
  }
}
