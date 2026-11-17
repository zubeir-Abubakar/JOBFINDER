"use server";

import { revalidatePath } from "next/cache";
import { redirect, notFound } from "next/navigation";
import { nowIso, one, run } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { randomId } from "@/lib/security";
import { analyseSingleJob, runDiscovery } from "@/lib/agents";
import { vacancyValidationError } from "@/lib/jobs";
import { audit } from "@/lib/audit";
import { getSetting } from "@/lib/settings";

export async function researchAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const pages = Math.min(5, Math.max(1, Number(formData.get("pages") ?? 2) || 2));
  const outcome = await runDiscovery(user.id, pages);
  revalidatePath("/jobs");
  revalidatePath("/dashboard");
  revalidatePath("/agents");
  const message = encodeURIComponent([outcome.summary, ...outcome.details].join(" · "));
  redirect(`/jobs?${outcome.status === "completed" ? "ok" : "error"}=${message}`);
}

export type ManualJobState = { error?: string };

export async function addManualJobAction(_prev: ManualJobState | undefined, formData: FormData): Promise<ManualJobState> {
  const user = await requireUser();
  const title = String(formData.get("title") ?? "").trim();
  const company = String(formData.get("company") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const url = String(formData.get("url") ?? "").trim();
  const location = String(formData.get("location") ?? "").trim();
  if (!title || !company) return { error: "Job title and company are required." };
  if (description.length < 40) return { error: "Paste the vacancy description (at least 40 characters) so the analysis is meaningful." };
  const invalid = vacancyValidationError({ title, company, location, url, description });
  if (invalid) return { error: `${invalid}. Paste the real employer posting so every stored vacancy remains traceable.` };

  const externalId = url;
  const existing = one<{ id: string }>("SELECT id FROM jobs WHERE lower(trim(title)) = lower(trim(?)) AND lower(trim(company)) = lower(trim(?))", [title, company]);
  if (existing) return { error: "A vacancy with this title and company already exists. Open it from the job list instead." };

  const id = `job_${randomId()}`;
  const salaryValue = String(formData.get("salary") ?? "").trim();
  run(
    `INSERT INTO jobs (id, source, external_id, title, company, location, remote, employment_type, salary, url, description, discovered_at, status)
     VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
    [
      id,
      externalId,
      title,
      company,
      location,
      formData.get("remote") === "on" ? 1 : 0,
      String(formData.get("employment_type") ?? "").trim() || null,
      salaryValue || null,
      url,
      description,
      nowIso(),
    ],
  );
  analyseSingleJob(id);
  audit({ action: "job.added_manually", entity: "job", entityId: id, detail: `${title} at ${company}`, userId: user.id });
  revalidatePath("/jobs");
  redirect(`/jobs/${id}?ok=${encodeURIComponent("Vacancy added and analysed against your profile.")}`);
}

export async function analyseJobAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const jobId = String(formData.get("job_id") ?? "");
  const job = one<{ id: string }>("SELECT id FROM jobs WHERE id = ?", [jobId]);
  if (!job) notFound();
  const analysis = analyseSingleJob(jobId);
  audit({ action: "job.analysed", entity: "job", entityId: jobId, detail: analysis ? `Score ${analysis.score}` : "Analysis failed", userId: user.id });
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/jobs");
  revalidatePath("/dashboard");
  redirect(`/jobs/${jobId}?ok=${encodeURIComponent(analysis ? `Analysis complete — ${analysis.score}% match.` : "Analysis could not be completed.")}`);
}

export async function setJobStatusAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const jobId = String(formData.get("job_id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!["new", "shortlisted", "rejected", "documents", "applied"].includes(status)) redirect("/jobs?error=Invalid+status");
  run("UPDATE jobs SET status = ? WHERE id = ?", [status, jobId]);
  audit({ action: `job.${status}`, entity: "job", entityId: jobId, userId: user.id });
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${jobId}`);
  const label = status === "rejected" ? "Vacancy rejected" : status === "shortlisted" ? "Added to shortlist" : "Vacancy updated";
  redirect(`/jobs/${jobId}?ok=${encodeURIComponent(label)}`);
}

export async function toggleJobSourceAction(formData: FormData): Promise<void> {
  await requireUser();
  const key = String(formData.get("key") ?? "");
  const source = one<{ enabled: number }>("SELECT enabled FROM job_sources WHERE key = ?", [key]);
  if (!source) redirect("/jobs?error=Source+not+found");
  run("UPDATE job_sources SET enabled = ? WHERE key = ?", [source.enabled ? 0 : 1, key]);
  revalidatePath("/jobs");
  redirect("/jobs?saved=1");
}

export async function createApplicationForJobAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const jobId = String(formData.get("job_id") ?? "");
  const job = one<{ id: string }>("SELECT id FROM jobs WHERE id = ?", [jobId]);
  if (!job) notFound();
  const existing = one<{ id: string }>("SELECT id FROM applications WHERE job_id = ?", [jobId]);
  if (existing) redirect(`/applications?ok=${encodeURIComponent("An application record already exists for this vacancy.")}`);
  const approval = getSetting<boolean>("approval_mode", true);
  const id = `app_${randomId()}`;
  run("INSERT INTO applications (id, job_id, status, method, last_update, created_at) VALUES (?, ?, ?, 'employer_portal', ?, ?)", [
    id,
    jobId,
    approval ? "awaiting_approval" : "documents_preparing",
    nowIso(),
    nowIso(),
  ]);
  run("UPDATE jobs SET status = 'documents' WHERE id = ? AND status != 'rejected'", [jobId]);
  audit({ action: "application.created", entity: "application", entityId: id, detail: `Job ${jobId}`, userId: user.id });
  revalidatePath("/applications");
  redirect(`/applications?ok=${encodeURIComponent("Application record created.")}`);
}
