/**
 * Pure helpers for the owner document library. Grouping is presentation only:
 * a document record is rendered exactly once, under the application/vacancy it
 * already references. No duplicate document rows are created.
 */
export type LibraryDocument = {
  id: string;
  job_id: string | null;
  company: string | null;
  title: string | null;
  kind: string;
  display_name: string;
};

export function filterLibraryDocuments<T extends LibraryDocument>(
  documents: T[],
  filters: { q?: string; kind?: string | null },
): T[] {
  const needle = (filters.q ?? "").trim().toLowerCase();
  return documents.filter((doc) => {
    if (filters.kind && doc.kind !== filters.kind) return false;
    if (!needle) return true;
    return [doc.company, doc.title, doc.display_name, doc.kind.replace(/_/g, " ")].some((value) =>
      (value ?? "").toLowerCase().includes(needle),
    );
  });
}

export type DocumentGroup<T> = {
  key: string;
  jobId: string | null;
  company: string | null;
  title: string | null;
  documents: T[];
};

/**
 * Groups by application/vacancy. Original CVs and generated files without a
 * vacancy are grouped individually so their employer/title label can never be
 * confused with another application.
 */
export function groupLibraryDocuments<T extends LibraryDocument>(documents: T[]): DocumentGroup<T>[] {
  const groups = new Map<string, DocumentGroup<T>>();
  for (const doc of documents) {
    const key = doc.job_id ? `job:${doc.job_id}` : `document:${doc.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.documents.push(doc);
      continue;
    }
    groups.set(key, {
      key,
      jobId: doc.job_id,
      company: doc.company,
      title: doc.title,
      documents: [doc],
    });
  }
  return [...groups.values()];
}
