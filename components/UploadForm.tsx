"use client";

import { useActionState } from "react";
import { uploadCvAction, type UploadState } from "@/lib/actions/documents";
import { SubmitButton } from "./SubmitButton";

export function UploadForm() {
  const [state, action] = useActionState<UploadState | undefined, FormData>(uploadCvAction, undefined);

  return (
    <form action={action} className="stack" style={{ gap: 10 }}>
      {state?.error ? <div className="alert alert-error">{state.error}</div> : null}
      {state?.ok ? <div className="alert alert-ok">{state.ok}</div> : null}
      <div>
        <label className="label" htmlFor="cv">CV file</label>
        <input id="cv" name="cv" type="file" accept=".pdf,.docx,.txt,application/pdf,text/plain" className="input" required style={{ padding: 8 }} />
        <p className="hint">PDF, DOCX or TXT · maximum 8 MB · text is extracted locally, never sent to a third party.</p>
      </div>
      <SubmitButton pendingLabel="Uploading and parsing…" className="btn btn-primary">
        Upload CV
      </SubmitButton>
    </form>
  );
}
