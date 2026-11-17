"use client";

import { useActionState } from "react";
import { recordSubmissionAction, type SubmissionState } from "@/lib/actions/applications";
import { SubmitButton } from "./SubmitButton";

export function SubmissionForm({ applicationId, approved }: { applicationId: string; approved: boolean }) {
  const [state, action] = useActionState<SubmissionState | undefined, FormData>(recordSubmissionAction, undefined);

  return (
    <form action={action} className="stack" style={{ gap: 10 }}>
      {state?.error ? <div className="alert alert-error">{state.error}</div> : null}
      {state?.ok ? <div className="alert alert-ok">{state.ok}</div> : null}
      <input type="hidden" name="id" value={applicationId} />
      <div>
        <label className="label" htmlFor="method">Submission channel</label>
        <select id="method" name="method" className="select" defaultValue="employer_portal">
          <option value="employer_portal">Employer portal</option>
          <option value="email">Email application</option>
          <option value="recruiter">Recruiter</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="confirmation">Confirmation reference or message</label>
        <input id="confirmation" name="confirmation" className="input" required placeholder="e.g. Application #48213 received" />
        <p className="hint">
          Copy the reference shown by the employer after submitting. This platform never marks an application as submitted without it.
          {!approved ? " Approval mode is on — approve the package first." : ""}
        </p>
      </div>
      <SubmitButton className="btn btn-primary" pendingLabel="Recording…">
        Record confirmed submission
      </SubmitButton>
    </form>
  );
}
