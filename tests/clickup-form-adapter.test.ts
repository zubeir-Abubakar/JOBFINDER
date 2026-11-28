import test from "node:test";
import assert from "node:assert/strict";
import { answerFor, categoryFor, detectSecurity, type CandidateField, type CandidateProfile } from "../lib/candidate-forms.ts";
import { fileUploadBlocker, uploadPersistenceIssue, type FieldGroup } from "../lib/browser-form.ts";

/**
 * Synthetic reproduction of the Digt AG ClickUp form: three upload inputs that
 * share one placeholder, a required Department select, a required referral
 * select and no verified answer for either.
 */

const PROFILE: CandidateProfile = {
  fullName: "ABUBAKAR TOWFIQ",
  email: "zubeir.abubakar525@gmail.com",
  phone: "+4179 368 05 70",
  location: "Switzerland",
  linkedin: "https://linkedin.com/in/abubakar-towfiq",
  website: null,
  workAuthorisation: "Swiss Permit B — authorised to work in Switzerland without employer sponsorship",
  summary: "Senior QA Engineer.",
  skills: ["Playwright", "SQL"],
  languages: ["English"],
  experienceText: "Lead QA Engineer at Cashia.",
  educationText: null,
  sponsorshipAnswer: "No",
};

const DOCUMENTS = {
  cv: { buffer: Buffer.from("%PDF-1.4 cv"), name: "CV_Test_Engineer.pdf" },
  cover: { buffer: Buffer.from("%PDF-1.4 cover"), name: "Cover_Letter_Test_Engineer.pdf" },
  coverText: "Cover letter text.",
};

const UNAUTHORISED = {};

function field(input: Partial<CandidateField> & { name: string; label: string }): CandidateField {
  return {
    type: "text",
    required: false,
    options: [],
    hidden: false,
    accept: null,
    value: null,
    ...input,
  };
}

function group(candidate: CandidateField): FieldGroup {
  return { field: candidate, controls: [], kind: candidate.type === "file" ? "file" : candidate.type === "select" ? "select" : "text" };
}

test("three upload fields sharing one placeholder are not all classified as the CV", () => {
  const uploads = ["cu-form-file-field-input-1", "cu-form-file-field-input-4", "cu-form-file-field-input-7"].map((name) =>
    field({ name, label: "Drop your files here to upload", type: "file", accept: ".pdf,.doc,.docx" }),
  );
  for (const upload of uploads) {
    assert.equal(categoryFor(upload), "unknown_file", `${upload.name} must not default to the CV`);
  }
  const blocker = fileUploadBlocker(uploads.map(group));
  assert.ok(blocker);
  assert.match(blocker!, /cannot be told apart/);
  assert.match(blocker!, /nothing was sent/i);
});

test("distinguishable upload fields are mapped to the CV and the cover letter", () => {
  const cv = field({
    name: "upload-1",
    label: "Drop your files here to upload",
    context: "Curriculum vitae",
    type: "file",
    accept: ".pdf",
    required: true,
  });
  const cover = field({
    name: "upload-2",
    label: "Drop your files here to upload",
    context: "Cover letter / motivation",
    type: "file",
    accept: ".pdf",
    required: true,
  });
  const other = field({ name: "upload-3", label: "Drop your files here to upload", context: "References", type: "file" });
  assert.equal(categoryFor(cv), "cv_file");
  assert.equal(categoryFor(cover), "cover_file");
  assert.equal(categoryFor(other), "unknown_file");
  assert.equal(fileUploadBlocker([cv, cover, other].map(group)), null);

  const cvAnswer = answerFor("cv_file", cv, PROFILE, DOCUMENTS, UNAUTHORISED);
  const coverAnswer = answerFor("cover_file", cover, PROFILE, DOCUMENTS, UNAUTHORISED);
  assert.equal(cvAnswer.action, "answer");
  assert.equal(cvAnswer.answer, "CV_Test_Engineer.pdf");
  assert.equal(coverAnswer.answer, "Cover_Letter_Test_Engineer.pdf");
});

test("a DOM name is stronger evidence than the shared placeholder", () => {
  const byName = field({ name: "resume", label: "Drop your files here to upload", type: "file" });
  assert.equal(categoryFor(byName), "cv_file");
});

test("a required Department select with no verified answer stops before submission", () => {
  const department = field({
    name: "cu-form-control-9",
    label: "Department",
    type: "select",
    required: true,
    options: [
      { value: "", label: "Select an option" },
      { value: "qa", label: "Quality Assurance" },
      { value: "dev", label: "Engineering" },
    ],
  });
  const question = answerFor(categoryFor(department), department, PROFILE, DOCUMENTS, UNAUTHORISED);
  assert.equal(question.action, "intervention");
  assert.match(question.reason, /not covered by verified profile data/i);
  assert.equal(question.answer, null);
});

test("a required referral source is a missing answer, not an optional blank", () => {
  const referral = field({
    name: "cu-form-control-12",
    label: "How did you hear about us?",
    type: "select",
    required: true,
    options: [
      { value: "", label: "Select" },
      { value: "linkedin", label: "LinkedIn" },
      { value: "other", label: "Other" },
    ],
  });
  const question = answerFor(categoryFor(referral), referral, PROFILE, DOCUMENTS, UNAUTHORISED);
  assert.equal(question.action, "intervention");
  assert.match(question.reason, /referral source/i);

  const optional = answerFor(categoryFor({ ...referral, required: false }), { ...referral, required: false }, PROFILE, DOCUMENTS, UNAUTHORISED);
  assert.equal(optional.action, "blank");
});

test("an owner-authorised referral answer is applied to the matching option", () => {
  const referral = field({
    name: "source",
    label: "How did you hear about us?",
    type: "select",
    required: true,
    options: [
      { value: "", label: "Select" },
      { value: "linkedin", label: "LinkedIn" },
      { value: "other", label: "Other" },
    ],
  });
  const question = answerFor(categoryFor(referral), referral, PROFILE, DOCUMENTS, { referral: "LinkedIn" });
  assert.equal(question.action, "answer");
  assert.equal(question.answer, "linkedin");
});

test("an owner-supplied answer unblocks the exact required question, and only that question", () => {
  const department = field({
    name: "cu-form-control-9",
    label: "Department",
    type: "select",
    required: true,
    options: [
      { value: "", label: "Select an option" },
      { value: "qa", label: "Quality Assurance" },
      { value: "dev", label: "Engineering" },
    ],
  });
  const byLabel = answerFor(categoryFor(department), department, PROFILE, DOCUMENTS, { department: "Quality Assurance" });
  assert.equal(byLabel.action, "answer");
  assert.equal(byLabel.answer, "qa", "the answer is mapped to the real option value");

  const byName = answerFor(categoryFor(department), department, PROFILE, DOCUMENTS, { "cu-form-control-9": "Engineering" });
  assert.equal(byName.action, "answer");
  assert.equal(byName.answer, "dev");

  // An answer that matches no option is refused, not forced.
  const unmatched = answerFor(categoryFor(department), department, PROFILE, DOCUMENTS, { department: "Marketing" });
  assert.equal(unmatched.action, "intervention");
  assert.match(unmatched.reason, /No option on the form matches/i);

  // A question the owner did not answer still stops the run.
  const other = field({ name: "cu-form-control-14", label: "Security clearance", type: "select", required: true, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] });
  assert.equal(answerFor(categoryFor(other), other, PROFILE, DOCUMENTS, { department: "Quality Assurance" }).action, "intervention");

  const referralField = field({
    name: "cu-form-control-12",
    label: "How did you hear about us?",
    type: "select",
    required: true,
    options: [
      { value: "linkedin", label: "LinkedIn" },
      { value: "other", label: "Other" },
    ],
  });
  const referralByLabel = answerFor(categoryFor(referralField), referralField, PROFILE, DOCUMENTS, {
    "how did you hear about us?": "LinkedIn",
  });
  assert.equal(referralByLabel.action, "answer");
  assert.equal(referralByLabel.answer, "linkedin");
});

test("a required unidentified upload is an intervention, never a CV upload", () => {
  const upload = field({ name: "attachment-1", label: "Drop your files here to upload", type: "file", required: true });
  const question = answerFor(categoryFor(upload), upload, PROFILE, DOCUMENTS, UNAUTHORISED);
  assert.equal(question.action, "intervention");
  assert.equal(question.answer, null);
});

test("upload persistence is verified by filename, not by a non-zero count", () => {
  assert.match(uploadPersistenceIssue([], "CV_Test_Engineer.pdf") ?? "", /cleared by the form/i);
  assert.match(
    uploadPersistenceIssue(["placeholder.pdf"], "CV_Test_Engineer.pdf") ?? "",
    /instead of the validated document/i,
  );
  assert.equal(uploadPersistenceIssue(["CV_Test_Engineer.pdf"], "CV_Test_Engineer.pdf"), null);
});

test("CAPTCHA and security challenges are reported as a handoff", () => {
  assert.match(detectSecurity("<div class=\"g-recaptcha\"></div>") ?? "", /CAPTCHA/i);
  assert.match(detectSecurity("Please complete the reCAPTCHA to continue") ?? "", /CAPTCHA/i);
  assert.match(detectSecurity("Sign in to apply for this role") ?? "", /login/i);
  assert.match(detectSecurity("Checking your browser before accessing the site") ?? "", /security challenge/i);
});
