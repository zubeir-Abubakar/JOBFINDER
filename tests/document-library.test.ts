import assert from "node:assert/strict";
import test from "node:test";
import { filterLibraryDocuments, groupLibraryDocuments } from "../lib/document-library";

const documents = [
  { id: "doc-cv", job_id: "job-1", company: "SumUp", title: "Senior QA Engineer", kind: "tailored_cv", display_name: "CV · SumUp" },
  { id: "doc-cover", job_id: "job-1", company: "SumUp", title: "Senior QA Engineer", kind: "cover_letter", display_name: "Cover letter · SumUp" },
  { id: "doc-other", job_id: "job-2", company: "Adyen", title: "SDET", kind: "tailored_cv", display_name: "CV · Adyen" },
  { id: "doc-original", job_id: null, company: null, title: null, kind: "original_cv", display_name: "Original CV" },
];

test("documents are labelled by employer and vacancy and grouped by application", () => {
  const groups = groupLibraryDocuments(documents);
  assert.equal(groups.length, 3);
  const sumup = groups.find((group) => group.jobId === "job-1");
  assert.ok(sumup);
  assert.equal(sumup.company, "SumUp");
  assert.equal(sumup.title, "Senior QA Engineer");
  assert.deepEqual(sumup.documents.map((doc) => doc.id), ["doc-cv", "doc-cover"]);
  const unlinked = groups.find((group) => group.jobId === null);
  assert.ok(unlinked);
  assert.equal(unlinked.documents.length, 1, "unlinked files never merge into another application");
});

test("the same record is rendered exactly once", () => {
  const ids = groupLibraryDocuments(documents).flatMap((group) => group.documents.map((doc) => doc.id));
  assert.equal(ids.length, documents.length);
  assert.equal(new Set(ids).size, documents.length);
});

test("search and type filters do not cross application boundaries", () => {
  assert.deepEqual(filterLibraryDocuments(documents, { q: "adyen" }).map((doc) => doc.id), ["doc-other"]);
  assert.deepEqual(filterLibraryDocuments(documents, { q: "cover" }).map((doc) => doc.id), ["doc-cover"]);
  assert.deepEqual(
    filterLibraryDocuments(documents, { q: "senior qa", kind: "tailored_cv" }).map((doc) => doc.id),
    ["doc-cv"],
  );
  assert.deepEqual(filterLibraryDocuments(documents, { kind: "cover_letter" }).map((doc) => doc.id), ["doc-cover"]);
});
