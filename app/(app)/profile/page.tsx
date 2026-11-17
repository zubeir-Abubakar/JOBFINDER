import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getProfileData, profileCompleteness, skillLevelLabel } from "@/lib/profile";
import { PageHead, Flash, Progress } from "@/components/ui";
import { formatDate, param } from "@/lib/format";
import {
  updateProfileAction,
  addSkillAction,
  updateSkillAction,
  deleteSkillAction,
  addExperienceAction,
  updateExperienceAction,
  deleteExperienceAction,
  addProfileItemAction,
  deleteProfileItemAction,
  saveLanguagesAction,
} from "@/lib/actions/profile";
import { SubmitButton } from "@/components/SubmitButton";
import { Icon } from "@/components/icons";

export const dynamic = "force-dynamic";

const LEVELS = ["exposure", "working", "advanced", "expert"];
const CATEGORIES = ["Automation & testing", "Programming", "DevOps & infrastructure", "Performance & monitoring", "QA management", "From CV", "Other"];

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
  const grouped = new Map<string, typeof data.skills>();
  for (const skill of data.skills) {
    const list = grouped.get(skill.category) ?? [];
    list.push(skill);
    grouped.set(skill.category, list);
  }
  const items = data.items;

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} saved={param(sp.saved)} imported={param(sp.imported)} />
      <PageHead
        title="Professional profile"
        sub="Every agent reads this single verified profile. Nothing here is inferred; the uploaded CV takes precedence over incomplete fields."
        actions={
          <>
            <Link href="/documents#upload" className="btn"><Icon name="docs" /> Upload CV</Link>
            <a href="#experience" className="btn">Experience</a>
          </>
        }
      />

      <section className="card mb-4">
        <div className="card-body grid g3" style={{ paddingTop: 18 }}>
          <div>
            <div className="label">Profile completeness</div>
            <div className="flex items-center gap-3">
              <span className="num text-[26px] font-semibold">{completeness}%</span>
              <div className="flex-1"><Progress value={completeness} /></div>
            </div>
            <p className="hint">Original CV: {p.source_cv_id ? `linked (${p.source_cv_id.slice(0, 12)}…)` : "not uploaded"}</p>
          </div>
          <div>
            <div className="label">Verified skills</div>
            <div className="text-[13px]">{data.skills.length} across {grouped.size} categories</div>
            <p className="hint">Exposure-only skills are never presented as expertise.</p>
          </div>
          <div>
            <div className="label">Work authorisation</div>
            <div className="text-[13px]">{p.work_authorisation ?? "Not recorded"}</div>
            <p className="hint">{p.permit_valid_until ? `Permit valid until ${p.permit_valid_until}` : "Add permit validity"}</p>
          </div>
        </div>
      </section>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Profile details</h2>
            <p className="card-sub">Used in every generated CV and cover letter.</p>
          </div>
        </div>
        <div className="card-body">
          <form action={updateProfileAction} className="grid g2" style={{ gap: 12 }}>
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
            <div style={{ gridColumn: "1 / -1" }}>
              <label className="label" htmlFor="summary">Professional summary</label>
              <textarea id="summary" name="summary" className="textarea" rows={4} defaultValue={p.summary ?? ""} />
              <p className="hint">Generated documents quote this summary. Keep every claim true. Employment dates are never invented.</p>
            </div>
            <div className="flex items-end">
              <SubmitButton className="btn btn-primary" pendingLabel="Saving…">Save profile</SubmitButton>
            </div>
          </form>
        </div>
      </section>

      <div className="split mb-4">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Skills library</h2>
              <p className="card-sub">Agents rank matching skills for each vacancy. Levels are honest: exposure is not expertise.</p>
            </div>
            <Link href="/documents#upload" className="btn btn-sm">Import from CV</Link>
          </div>
          <div className="card-body">
            {[...grouped.entries()].map(([category, skills]) => (
              <div key={category} className="mb-4">
                <div className="label">{category}</div>
                <div className="stack" style={{ gap: 4 }}>
                  {skills.map((skill) => (
                    <form key={skill.id} action={updateSkillAction} className="between card-quiet px-2.5 py-1.5" style={{ gap: 6 }}>
                      <input type="hidden" name="id" value={skill.id} />
                      <span className="text-[12.5px]">{skill.name}</span>
                      <div className="row" style={{ gap: 4 }}>
                        <select name="level" className="select" defaultValue={skill.level} style={{ width: 112, padding: "4px 6px", fontSize: 11.5 }} aria-label={`Level for ${skill.name}`}>
                          {LEVELS.map((level) => <option key={level} value={level}>{skillLevelLabel(level)}</option>)}
                        </select>
                        <SubmitButton className="btn btn-sm">Save</SubmitButton>
                        <SubmitButton
                          className="btn btn-sm btn-danger"
                          formAction={deleteSkillAction}
                          confirm={`Remove ${skill.name} from your library?`}
                        >
                          ×
                        </SubmitButton>
                      </div>
                    </form>
                  ))}
                </div>
              </div>
            ))}
            <form action={addSkillAction} className="grid g2" style={{ gap: 8, marginTop: 8 }}>
              <div style={{ gridColumn: "1 / -1" }}>
                <label className="label" htmlFor="skill_name">Add a skill</label>
                <input id="skill_name" name="name" className="input" placeholder="e.g. Maestro" required />
              </div>
              <div>
                <label className="label" htmlFor="category">Category</label>
                <select id="category" name="category" className="select" defaultValue="Automation & testing">
                  {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="level">Level</label>
                <select id="level" name="level" className="select" defaultValue="working">
                  {LEVELS.map((l) => <option key={l} value={l}>{skillLevelLabel(l)}</option>)}
                </select>
              </div>
              <div className="flex items-end">
                <SubmitButton className="btn" pendingLabel="Adding…">Add skill</SubmitButton>
              </div>
            </form>
          </div>
        </section>

        <div className="stack">
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Languages</h2>
                <p className="card-sub">Used for language compatibility scoring.</p>
              </div>
            </div>
            <div className="card-body">
              <form action={saveLanguagesAction} className="stack" style={{ gap: 8 }}>
                <input name="languages" className="input" defaultValue={data.languages.join(", ")} placeholder="English, French (B1)" />
                <SubmitButton className="btn">Save languages</SubmitButton>
              </form>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Education, certifications & projects</h2>
                <p className="card-sub">Only add qualifications you can evidence.</p>
              </div>
            </div>
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
          </section>
        </div>
      </div>

      <section className="card" id="experience">
        <div className="card-head">
          <div>
            <h2>Professional experience</h2>
            <p className="card-sub">Seeded from the brief without dates or achievements that were not provided. Upload your CV or add dates here.</p>
          </div>
        </div>
        <div className="card-body">
          <div className="stack mb-4" style={{ gap: 10 }}>
            {data.experiences.map((exp) => (
              <div key={exp.id} className="card-quiet p-3">
                <div className="between">
                  <div>
                    <div className="text-[13.5px] font-semibold">{exp.title} — {exp.company}</div>
                    <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                      {exp.start_date ? formatDate(exp.start_date) : "Start date missing"} – {exp.is_current ? "Present" : exp.end_date ? formatDate(exp.end_date) : "End date missing"}
                      {exp.location ? ` · ${exp.location}` : ""}
                    </div>
                  </div>
                  <details>
                    <summary className="btn btn-sm" style={{ listStyle: "none", cursor: "pointer" }}>Edit</summary>
                    <div className="mt-2">
                      <form action={updateExperienceAction} className="grid g2" style={{ gap: 8, minWidth: 300 }}>
                        <input type="hidden" name="id" value={exp.id} />
                        <div>
                          <label className="label">Location</label>
                          <input name="location" className="input" defaultValue={exp.location ?? ""} />
                        </div>
                        <div className="flex items-end gap-2">
                          <div>
                            <label className="label">Start</label>
                            <input name="start_date" className="input" placeholder="2021-03" defaultValue={exp.start_date ?? ""} />
                          </div>
                          <div>
                            <label className="label">End</label>
                            <input name="end_date" className="input" placeholder="2024-08" defaultValue={exp.end_date ?? ""} />
                          </div>
                        </div>
                        <label className="flex items-center gap-2 text-[12px]">
                          <input type="checkbox" name="is_current" defaultChecked={Boolean(exp.is_current)} /> Current role
                        </label>
                        <div style={{ gridColumn: "1 / -1" }}>
                          <label className="label">Summary</label>
                          <textarea name="summary" className="textarea" rows={2} defaultValue={exp.summary ?? ""} />
                        </div>
                        <div style={{ gridColumn: "1 / -1" }}>
                          <label className="label">Achievements (one per line)</label>
                          <textarea
                            name="achievements"
                            className="textarea"
                            rows={3}
                            defaultValue={(() => {
                              try {
                                const parsed = JSON.parse(exp.achievements ?? "[]");
                                return Array.isArray(parsed) ? parsed.join("\n") : "";
                              } catch {
                                return "";
                              }
                            })()}
                          />
                        </div>
                        <div className="row">
                          <SubmitButton className="btn btn-primary">Save role</SubmitButton>
                        </div>
                      </form>
                      <form action={deleteExperienceAction} className="mt-2">
                        <input type="hidden" name="id" value={exp.id} />
                        <SubmitButton className="btn btn-sm btn-danger" confirm="Delete this role from the profile?">Delete role</SubmitButton>
                      </form>
                    </div>
                  </details>
                </div>
                {exp.summary ? <p className="mt-2 text-[12px]">{exp.summary}</p> : (
                  <p className="mt-2 text-[11.5px]" style={{ color: "var(--muted)" }}>No summary yet — generated CVs will show the role without invented achievements.</p>
                )}
              </div>
            ))}
          </div>

          <details>
            <summary className="btn" style={{ listStyle: "none", cursor: "pointer", display: "inline-flex" }}>
              <Icon name="plus" size={12} /> Add a role
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
                <label className="label" htmlFor="exp_summary">Summary</label>
                <textarea id="exp_summary" name="summary" className="textarea" rows={2} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label className="label" htmlFor="exp_achievements">Achievements (one per line)</label>
                <textarea id="exp_achievements" name="achievements" className="textarea" rows={2} />
              </div>
              <div className="row">
                <SubmitButton className="btn btn-primary">Add role</SubmitButton>
              </div>
            </form>
          </details>
        </div>
      </section>
    </>
  );
}
