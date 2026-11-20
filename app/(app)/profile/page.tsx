import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getProfileData, profileCompleteness } from "@/lib/profile";
import { ProfileSync } from "@/components/ProfileSync";
import { PageHead, Flash, Progress } from "@/components/ui";
import { formatDate, param } from "@/lib/format";
import {
  updateProfileAction,
  addExperienceAction,
  updateExperienceAction,
  deleteExperienceAction,
  addProfileItemAction,
  deleteProfileItemAction,
} from "@/lib/actions/profile";
import { SubmitButton } from "@/components/SubmitButton";
import { Icon } from "@/components/icons";
import { LanguageEditor } from "@/components/LanguageEditor";
import { RichTextEditor } from "@/components/RichTextEditor";
import { SkillsEditor } from "@/components/SkillsEditor";
import { HashDetails } from "@/components/HashDetails";
import { listToHtml, plainTextToHtml, sanitizeRichText } from "@/lib/rich-text";

export const dynamic = "force-dynamic";

function achievementValues(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const sp = await searchParams;
  const data = getProfileData();
  const p = data.profile;
  const completeness = profileCompleteness(data);
  const categoryCount = new Set(data.skills.map((skill) => skill.category)).size;
  const items = data.items;

  return (
    <>
      <ProfileSync />
      <HashDetails ids={["personal", "skills", "experience"]} />
      <Flash ok={param(sp.ok)} error={param(sp.error)} saved={param(sp.saved)} imported={param(sp.imported)} />
      <div className="profile-page">
        <PageHead
          title="Professional profile"
          sub="Every agent reads this single verified profile. Your uploaded CV is imported here but is never overwritten."
          actions={
            <>
              <Link href="/documents#upload" className="btn"><Icon name="docs" /> Upload CV</Link>
              <a href="#experience" className="btn">Experience</a>
            </>
          }
        />

        <section className="card profile-stats">
          <div className="card-body grid g3">
            <div>
              <div className="label">Profile completeness</div>
              <div className="flex items-center gap-3">
                <span className="num text-[24px] font-semibold">{completeness}%</span>
                <div className="flex-1"><Progress value={completeness} /></div>
              </div>
              <p className="hint">Original CV: {p.source_cv_id ? `linked (${p.source_cv_id.slice(0, 12)}…)` : "not uploaded"}</p>
            </div>
            <div>
              <div className="label">CV skills</div>
              <div className="text-[13px]">{data.skills.length} across {categoryCount} categories</div>
              <p className="hint">Only skills from your CV and skills you add manually are used.</p>
            </div>
            <div>
              <div className="label">Work authorisation</div>
              <div className="text-[13px]">{p.work_authorisation ?? "Not recorded"}</div>
              <p className="hint">{p.permit_valid_until ? `Permit valid until ${p.permit_valid_until}` : "Add permit validity"}</p>
            </div>
          </div>
        </section>

        <details className="card profile-collapse" id="personal" open>
          <summary className="card-head">
            <div>
              <h2>Personal details</h2>
              <p className="card-sub">Used in every generated CV and cover letter.</p>
            </div>
            <span className="profile-summary-meta"><span className="badge badge-good">Verified source</span><span className="profile-chevron" aria-hidden="true">⌄</span></span>
          </summary>
          <div className="card-body">
            <form action={updateProfileAction} className="grid g2 profile-form">
              <div>
                <label className="label" htmlFor="full_name">Full name</label>
                <input id="full_name" name="full_name" className="input" defaultValue={p.full_name ?? ""} />
              </div>
              <div>
                <label className="label" htmlFor="headline">Professional headline</label>
                <input id="headline" name="headline" className="input" defaultValue={p.headline ?? ""} />
              </div>
              <div>
                <label className="label" htmlFor="email">Email</label>
                <input id="email" name="email" type="email" className="input" defaultValue={p.email ?? ""} />
              </div>
              <div>
                <label className="label" htmlFor="phone">Phone</label>
                <input id="phone" name="phone" className="input" defaultValue={p.phone ?? ""} />
              </div>
              <div>
                <label className="label" htmlFor="location">Location</label>
                <input id="location" name="location" className="input" defaultValue={p.location ?? ""} />
              </div>
              <div>
                <label className="label" htmlFor="permit_valid_until">Permit valid until</label>
                <input id="permit_valid_until" name="permit_valid_until" className="input" placeholder="2028-02" defaultValue={p.permit_valid_until ?? ""} />
              </div>
              <div>
                <label className="label" htmlFor="linkedin">LinkedIn</label>
                <input id="linkedin" name="linkedin" className="input" defaultValue={p.linkedin ?? ""} />
              </div>
              <div>
                <label className="label" htmlFor="website">Website</label>
                <input id="website" name="website" className="input" defaultValue={p.website ?? ""} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label className="label" htmlFor="work_authorisation">Work authorisation</label>
                <input id="work_authorisation" name="work_authorisation" className="input" defaultValue={p.work_authorisation ?? ""} />
              </div>
              <details className="profile-subsection" style={{ gridColumn: "1 / -1" }}>
                <summary>
                  <span><span className="profile-subsection-title">Professional summary</span><span className="profile-subsection-sub">The narrative every agent starts from</span></span>
                  <span className="profile-chevron" aria-hidden="true">⌄</span>
                </summary>
                <div className="profile-subsection-body">
                  <label className="label" htmlFor="summary">Summary</label>
                  <textarea id="summary" name="summary" className="textarea" rows={5} defaultValue={p.summary ?? ""} />
                  <p className="hint">Generated documents quote this summary. Keep every claim true. Employment dates are never invented.</p>
                </div>
              </details>
              <div className="flex items-center gap-3" style={{ gridColumn: "1 / -1" }}>
                <SubmitButton className="btn btn-primary" pendingLabel="Saving…">Save profile</SubmitButton>
                <span className="hint">This button activates when you edit a field.</span>
              </div>
            </form>
          </div>
        </details>

        <details className="card profile-collapse" id="skills">
          <summary className="card-head">
            <div>
              <h2>Skills</h2>
              <p className="card-sub">One list from your CV. Choose the level beside each skill, then save once.</p>
            </div>
            <span className="profile-summary-meta"><span className="badge badge-neutral">{data.skills.length} skills</span><span className="profile-chevron" aria-hidden="true">⌄</span></span>
          </summary>
          <div className="card-body">
            <SkillsEditor skills={data.skills} />
          </div>
        </details>

        <div className="profile-columns">
          <details className="card profile-collapse">
            <summary className="card-head">
              <div>
                <h2>Languages</h2>
                <p className="card-sub">Saved separately and used for compatibility scoring.</p>
              </div>
              <span className="row" style={{ gap: 8 }}>
                <span className="badge badge-neutral">{data.languageEntries.length}</span>
                <span className="profile-chevron" aria-hidden="true">⌄</span>
              </span>
            </summary>
            <div className="card-body">
              <LanguageEditor initial={data.languageEntries} />
            </div>
          </details>

          <details className="card profile-collapse">
            <summary className="card-head">
              <div>
                <h2>Education, certifications &amp; projects</h2>
                <p className="card-sub">Only add qualifications you can evidence.</p>
              </div>
              <span className="profile-summary-meta"><span className="badge badge-neutral">{items.length}</span><span className="profile-chevron" aria-hidden="true">⌄</span></span>
            </summary>
            <div className="card-body">
              {items.length === 0 ? (
                <p className="text-[12px]" style={{ color: "var(--muted)" }}>No entries. Nothing is invented on your behalf.</p>
              ) : (
                <div className="stack mb-3" style={{ gap: 6 }}>
                  {items.map((item) => (
                    <div key={item.id} className="between card-quiet px-3 py-2">
                      <div>
                        <div className="text-[12.5px] font-medium">{item.title}</div>
                        <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                          {item.kind} {item.subtitle ? `· ${item.subtitle}` : ""} {item.start_date ? `· ${item.start_date}` : ""}
                        </div>
                      </div>
                      <form action={deleteProfileItemAction}>
                        <input type="hidden" name="id" value={item.id} />
                        <SubmitButton className="btn btn-sm btn-danger" confirm="Remove this entry?">×</SubmitButton>
                      </form>
                    </div>
                  ))}
                </div>
              )}
              <form action={addProfileItemAction} className="grid g2" style={{ gap: 8 }}>
                <div>
                  <label className="label" htmlFor="kind">Type</label>
                  <select id="kind" name="kind" className="select" defaultValue="certification">
                    <option value="education">Education</option>
                    <option value="certification">Certification</option>
                    <option value="project">Project</option>
                    <option value="achievement">Achievement</option>
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="item_title">Title</label>
                  <input id="item_title" name="title" className="input" required />
                </div>
                <div>
                  <label className="label" htmlFor="subtitle">Institution / issuer</label>
                  <input id="subtitle" name="subtitle" className="input" />
                </div>
                <div>
                  <label className="label" htmlFor="end_date">Date</label>
                  <input id="end_date" name="end_date" className="input" placeholder="2024" />
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <label className="label" htmlFor="detail">Detail</label>
                  <input id="detail" name="detail" className="input" placeholder="Optional context, no invented claims" />
                </div>
                <div className="flex items-end">
                  <SubmitButton className="btn">Add entry</SubmitButton>
                </div>
              </form>
            </div>
          </details>
        </div>

        <details className="card profile-collapse" id="experience">
          <summary className="card-head">
            <div>
              <h2>Professional experience</h2>
              <p className="card-sub">Roles and bullets are imported from the uploaded CV. Edit here without changing the original document.</p>
            </div>
            <span className="profile-summary-meta"><span className="badge badge-neutral">{data.experiences.length} role{data.experiences.length === 1 ? "" : "s"}</span><span className="profile-chevron" aria-hidden="true">⌄</span></span>
          </summary>
          <div className="card-body">
            {data.experiences.length === 0 ? (
              <div className="empty">
                <strong>No roles yet</strong>
                Import your CV or add a role below. Missing dates are never invented.
              </div>
            ) : (
              <div className="stack mb-4" style={{ gap: 8 }}>
                {data.experiences.map((exp) => {
                  const achievements = achievementValues(exp.achievements);
                  const summaryHtml = exp.responsibilities_html ? sanitizeRichText(exp.responsibilities_html) : plainTextToHtml(exp.summary);
                  const achievementsHtml = exp.achievements_html ? sanitizeRichText(exp.achievements_html) : listToHtml(achievements);
                  const projectsHtml = exp.projects_html ? sanitizeRichText(exp.projects_html) : plainTextToHtml(exp.projects);
                  return (
                    <div key={exp.id} className="card-quiet p-3">
                      <div className="between">
                        <div>
                          <div className="text-[13.5px] font-semibold">{exp.title} — {exp.company}</div>
                          <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                            {exp.start_date ? formatDate(exp.start_date) : "Start date missing"} – {exp.is_current ? "Present" : exp.end_date ? formatDate(exp.end_date) : "End date missing"}
                            {exp.location ? ` · ${exp.location}` : ""}
                            {!exp.edited_at ? <span className="badge badge-neutral" style={{ marginLeft: 7 }}>From CV</span> : null}
                          </div>
                        </div>
                        <details>
                          <summary className="btn btn-sm" style={{ listStyle: "none", cursor: "pointer" }}>Edit</summary>
                          <div className="mt-3">
                            <form action={updateExperienceAction} className="grid g2" style={{ gap: 9, minWidth: "min(300px, 100%)" }}>
                              <input type="hidden" name="id" value={exp.id} />
                              <div>
                                <label className="label" htmlFor={`title-${exp.id}`}>Job title</label>
                                <input id={`title-${exp.id}`} name="title" className="input" defaultValue={exp.title} required />
                              </div>
                              <div>
                                <label className="label" htmlFor={`company-${exp.id}`}>Company</label>
                                <input id={`company-${exp.id}`} name="company" className="input" defaultValue={exp.company} required />
                              </div>
                              <div>
                                <label className="label" htmlFor={`location-${exp.id}`}>Location</label>
                                <input id={`location-${exp.id}`} name="location" className="input" defaultValue={exp.location ?? ""} />
                              </div>
                              <div className="grid g2" style={{ gap: 6 }}>
                                <div>
                                  <label className="label" htmlFor={`start-${exp.id}`}>Start</label>
                                  <input id={`start-${exp.id}`} name="start_date" className="input" placeholder="2021-03" defaultValue={exp.start_date ?? ""} />
                                </div>
                                <div>
                                  <label className="label" htmlFor={`end-${exp.id}`}>End</label>
                                  <input id={`end-${exp.id}`} name="end_date" className="input" placeholder="2024-08" defaultValue={exp.end_date ?? ""} />
                                </div>
                              </div>
                              <label className="flex items-center gap-2 text-[12px]" style={{ gridColumn: "1 / -1" }}>
                                <input type="checkbox" name="is_current" defaultChecked={Boolean(exp.is_current)} /> Current role
                              </label>
                              <div style={{ gridColumn: "1 / -1" }}>
                                <label className="label">Responsibilities</label>
                                <RichTextEditor name="summary_html" defaultValue={summaryHtml} placeholder="Describe the role. Use ¶ for a new paragraph." ariaLabel={`Responsibilities for ${exp.title}`} />
                              </div>
                              <div style={{ gridColumn: "1 / -1" }}>
                                <label className="label">Achievements</label>
                                <RichTextEditor name="achievements_html" defaultValue={achievementsHtml} placeholder="Add an achievement, then use the bulleted list button." ariaLabel={`Achievements for ${exp.title}`} />
                              </div>
                              <div style={{ gridColumn: "1 / -1" }}>
                                <label className="label">Projects or technical details</label>
                                <RichTextEditor name="projects_html" defaultValue={projectsHtml} placeholder="Tools, systems or projects tied to this role." minHeight={64} ariaLabel={`Projects for ${exp.title}`} />
                              </div>
                              <div className="row" style={{ gridColumn: "1 / -1" }}>
                                <SubmitButton className="btn btn-primary">Save role</SubmitButton>
                              </div>
                            </form>
                            <form action={deleteExperienceAction} className="mt-2">
                              <input type="hidden" name="id" value={exp.id} />
                              <SubmitButton className="btn btn-sm btn-danger" confirm="Remove this role from your profile? The uploaded CV stays unchanged.">Remove role</SubmitButton>
                            </form>
                          </div>
                        </details>
                      </div>
                      {exp.summary ? <p className="mt-2 text-[12px]" style={{ whiteSpace: "pre-wrap" }}>{exp.summary}</p> : null}
                      {achievements.length > 0 ? (
                        <ul className="mt-2" style={{ paddingLeft: 20, fontSize: 12, color: "var(--ink-soft)" }}>
                          {achievements.slice(0, 4).map((achievement, index) => <li key={`${exp.id}-${index}`}>{achievement}</li>)}
                        </ul>
                      ) : null}
                      {exp.projects ? <p className="mt-2 text-[11.5px]" style={{ color: "var(--muted)" }}>Projects: {exp.projects}</p> : null}
                    </div>
                  );
                })}
              </div>
            )}

            <details>
              <summary className="btn" style={{ listStyle: "none", cursor: "pointer", display: "inline-flex" }}>
                <Icon name="plus" size={12} /> Add role
              </summary>
              <form action={addExperienceAction} className="grid g2 mt-3" style={{ gap: 10 }}>
                <div>
                  <label className="label" htmlFor="company">Company</label>
                  <input id="company" name="company" className="input" required />
                </div>
                <div>
                  <label className="label" htmlFor="title">Job title</label>
                  <input id="title" name="title" className="input" required />
                </div>
                <div>
                  <label className="label" htmlFor="start_date">Start</label>
                  <input id="start_date" name="start_date" className="input" placeholder="2021-03" />
                </div>
                <div>
                  <label className="label" htmlFor="end_date">End</label>
                  <input id="end_date" name="end_date" className="input" placeholder="2024-08" />
                </div>
                <div>
                  <label className="label" htmlFor="exp_location">Location</label>
                  <input id="exp_location" name="location" className="input" />
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" name="is_current" /> Current role</label>
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <label className="label">Responsibilities</label>
                  <RichTextEditor name="summary_html" defaultValue="" placeholder="Describe the role. Use ¶ for a new paragraph." ariaLabel="Responsibilities for the new role" />
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <label className="label">Achievements</label>
                  <RichTextEditor name="achievements_html" defaultValue="" placeholder="Add an achievement, then use the bulleted list button." ariaLabel="Achievements for the new role" />
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <label className="label">Projects or technical details</label>
                  <RichTextEditor name="projects_html" defaultValue="" placeholder="Tools, systems or projects tied to this role." minHeight={64} ariaLabel="Projects for the new role" />
                </div>
                <div className="row" style={{ gridColumn: "1 / -1" }}>
                  <SubmitButton className="btn btn-primary">Add role</SubmitButton>
                </div>
              </form>
            </details>
            <p className="hint mt-3">Removing a role hides it from future CVs but does not delete or change the uploaded PDF. All edits are saved to your profile immediately.</p>
          </div>
        </details>
      </div>
    </>
  );
}
