"use client";

import { useActionState } from "react";
import { addManualJobAction, type ManualJobState } from "@/lib/actions/jobs";
import { SubmitButton } from "./SubmitButton";

export function ManualJobForm() {
  const [state, action] = useActionState<ManualJobState | undefined, FormData>(addManualJobAction, undefined);

  return (
    <form action={action} className="stack" style={{ gap: 10 }}>
      {state?.error ? <div className="alert alert-error">{state.error}</div> : null}
      <div className="grid g2" style={{ gap: 10 }}>
        <div>
          <label className="label" htmlFor="title">Job title</label>
          <input id="title" name="title" className="input" required placeholder="Senior QA Engineer" />
        </div>
        <div>
          <label className="label" htmlFor="company">Company</label>
          <input id="company" name="company" className="input" required placeholder="Example Technology AG" />
        </div>
        <div>
          <label className="label" htmlFor="location">Location</label>
          <input id="location" name="location" className="input" required placeholder="Lausanne, Switzerland" />
        </div>
        <div>
          <label className="label" htmlFor="employment_type">Employment type</label>
          <input id="employment_type" name="employment_type" className="input" placeholder="Full-time" />
        </div>
        <div>
          <label className="label" htmlFor="salary">Salary (optional)</label>
          <input id="salary" name="salary" className="input" placeholder="CHF 120,000" />
        </div>
        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" name="remote" /> Remote role
          </label>
        </div>
      </div>
      <div>
        <label className="label" htmlFor="url">Original vacancy URL</label>
        <input id="url" name="url" type="url" className="input" required placeholder="https://employer.example/jobs/123" />
      </div>
      <div>
        <label className="label" htmlFor="description">Full job description</label>
        <textarea id="description" name="description" className="textarea" rows={7} required minLength={40} placeholder="Paste the vacancy text so the analysis agent can extract requirements." />
        <p className="hint">The analysis agent reads this text. Paste the real posting — never a summary.</p>
      </div>
      <SubmitButton pendingLabel="Adding and analysing…" className="btn btn-primary">
        Add vacancy and analyse
      </SubmitButton>
    </form>
  );
}
