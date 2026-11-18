import type { MasterCv } from "./master-cv";
import type { CoverLetterContent, TailoredCv } from "./document-ai";
import { coverDate, type CoverDocModel, type CvDocModel, type DocModel } from "./document-model";
import { renderCoverPdf, renderCvPdf } from "./docgen-pdf";
import { renderCoverDocx, renderCvDocx } from "./docgen-docx";

export type { CoverDocModel, CvDocModel, DocModel } from "./document-model";
export { documentFileBase, modelToText } from "./document-model";

export type JobLike = {
  title: string;
  company: string;
  location: string | null;
  description: string;
};

function words(value: string): string[] {
  return value.toLowerCase().match(/[a-z][a-z0-9+#./-]{2,}/g) ?? [];
}

function keywordSet(job: JobLike): Set<string> {
  return new Set(words(`${job.title} ${job.company} ${job.description}`));
}

function relevance(value: string, keywords: Set<string>): number {
  const tokens = new Set(words(value));
  let score = 0;
  for (const keyword of keywords) if (tokens.has(keyword)) score += keyword.length > 5 ? 2 : 1;
  return score;
}

/**
 * Build the document from the master CV and the validated tailoring. Only
 * wording and ordering within the original sections may change; every role,
 * bullet, certification, degree and language remains in the model.
 */
export function buildCvModel(input: { master: MasterCv; tailored: TailoredCv; job: JobLike }): CvDocModel {
  const { master, tailored, job } = input;
  const keywords = keywordSet(job);
  const skillGroups = master.skillGroups
    .map((group, index) => ({
      group: {
        ...group,
        values: [...group.values].sort((a, b) => relevance(b, keywords) - relevance(a, keywords)),
      },
      score: group.values.reduce((sum, value) => sum + relevance(value, keywords), 0),
      index,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.group);

  return {
    kind: "cv",
    name: master.name,
    headline: master.headline,
    contact: master.contact,
    permit: master.permit,
    summary: tailored.summary,
    skillGroups,
    roles: tailored.roles,
    certifications: master.certifications,
    education: master.education,
    languages: master.languages,
    meta: {
      sourceId: master.sourceId,
      sourceName: master.sourceName,
      tailoredWithAi: tailored.tailoredWithAi,
      provider: tailored.provider,
      model: tailored.model,
      generatedFor: { title: job.title, company: job.company },
    },
  };
}

export function buildCoverLetterModel(input: {
  master: MasterCv;
  cover: CoverLetterContent;
  job: JobLike;
}): CoverDocModel {
  const { master, cover, job } = input;
  return {
    kind: "cover",
    name: master.name,
    headline: master.headline,
    contact: master.contact,
    permit: master.permit,
    date: coverDate(),
    addressee: [job.company, job.location].filter((value): value is string => Boolean(value)),
    salutation: cover.salutation,
    paragraphs: cover.paragraphs,
    closing: cover.closing,
    meta: {
      sourceId: master.sourceId,
      sourceName: master.sourceName,
      tailoredWithAi: cover.tailoredWithAi,
      provider: cover.provider,
      model: cover.model,
      generatedFor: { title: job.title, company: job.company },
    },
  };
}

export async function renderPdf(model: DocModel): Promise<Buffer> {
  return model.kind === "cv" ? renderCvPdf(model) : renderCoverPdf(model);
}

export async function renderDocx(model: DocModel): Promise<Buffer> {
  return model.kind === "cv" ? renderCvDocx(model) : renderCoverDocx(model);
}
