import type { MasterEducation, MasterRole, MasterSkillGroup } from "./master-cv";

export type DocMeta = {
  sourceId: string | null;
  sourceName: string;
  tailoredWithAi: boolean;
  provider: string | null;
  model: string | null;
  generatedFor: { title: string; company: string };
};

export type CvDocModel = {
  kind: "cv";
  name: string;
  headline: string;
  contact: string[];
  permit: string | null;
  summary: string;
  skillGroups: MasterSkillGroup[];
  roles: MasterRole[];
  certifications: string[];
  education: MasterEducation[];
  languages: string;
  meta: DocMeta;
};

export type CoverDocModel = {
  kind: "cover";
  name: string;
  headline: string;
  contact: string[];
  permit: string | null;
  date: string;
  addressee: string[];
  salutation: string;
  paragraphs: string[];
  closing: string;
  meta: DocMeta;
};

export type DocModel = CvDocModel | CoverDocModel;

export function modelToText(model: DocModel): string {
  if (model.kind === "cv") {
    return [
      model.name,
      model.headline,
      model.contact.join(" | "),
      model.permit ?? "",
      "Professional Summary",
      model.summary,
      "Technical Skills",
      ...model.skillGroups.map((group) => `${group.label}: ${group.values.join(", ")}`),
      "Professional Experience",
      ...model.roles.flatMap((role) => [
        role.title,
        `${role.company}${role.location ? `, ${role.location}` : ""}`,
        role.dates,
        ...(role.summary ? [role.summary] : []),
        ...(role.note ? [role.note] : []),
        ...role.bullets,
        ...(role.projects ? [`Projects: ${role.projects}`] : []),
      ]),
      ...(model.certifications.length ? ["Certifications", ...model.certifications] : []),
      ...(model.education.length
        ? ["Education", ...model.education.flatMap((item) => [item.title, item.institution ?? "", item.date ?? ""])]
        : []),
      ...(model.languages ? ["Languages", model.languages] : []),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    model.name,
    model.headline,
    model.contact.join(" | "),
    model.permit ?? "",
    model.date,
    ...model.addressee,
    model.salutation,
    ...model.paragraphs,
    model.closing,
    model.name,
  ]
    .filter(Boolean)
    .join("\n");
}

export function documentFileBase(model: DocModel, version = "3.0"): string {
  const name = model.name.split(/\s+/)[0] || "Candidate";
  const title = model.meta.generatedFor.title;
  const company = model.meta.generatedFor.company;
  return `${name}_${title}_${company}_${model.kind === "cv" ? "CV" : "Cover_Letter"}_v${version.replace(/\./g, "_")}`
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
}

export function coverDate(): string {
  return new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
