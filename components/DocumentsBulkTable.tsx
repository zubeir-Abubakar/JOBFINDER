"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { deleteDocumentAction } from "@/lib/actions/documents";
import { formatBytes, formatDate } from "@/lib/format";
import { SubmitButton } from "./SubmitButton";
import { togglePinAction } from "@/lib/actions/documents";
import { DocumentDeleteButton } from "./DocumentDeleteButton";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./icons";

export type BulkDocument = {
  id: string;
  kind: string;
  display_name: string;
  file_name: string;
  mime: string;
  size_bytes: number;
  version: string | null;
  status: string;
  pinned: number;
  ats_score: number | null;
  quality_status: string | null;
  quality_score: number | null;
  created_at: string;
  expires_at: string | null;
  company: string | null;
  title: string | null;
  job_id: string | null;
};

/**
 * Presentation-only selection layer. Deletion still uses the existing
 * single-document server action; multi-select queues those exact forms through
 * a hidden sink so the action and payload contract stay untouched.
 */
export function DocumentsBulkTable({ documents }: { documents: BulkDocument[] }) {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const forms = useRef(new Map<string, HTMLFormElement>());

  const allSelected = documents.length > 0 && selected.size === documents.length;

  function toggleMode() {
    setSelectMode((value) => !value);
    setSelected(new Set());
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(documents.map((doc) => doc.id)));
  }

  async function deleteSelected() {
    setBusy(true);
    setConfirmOpen(false);
    for (const id of selected) {
      const form = forms.current.get(id);
      if (!form) continue;
      form.target = "document-delete-sink";
      HTMLFormElement.prototype.submit.call(form);
      await new Promise((resolve) => window.setTimeout(resolve, 220));
    }
    window.setTimeout(() => {
      window.location.assign("/documents?deleted=1");
    }, 700);
  }

  return (
    <>
      <div className="bulk-toolbar">
        <div className="bulk-toolbar-copy">
          <span className="bulk-toolbar-icon"><Icon name="docs" size={14} /></span>
          <span>{selectMode ? "Select documents to remove them together." : "Manage generated files for each vacancy."}</span>
        </div>
        <button type="button" className={`btn btn-sm ${selectMode ? "btn-primary" : ""}`} onClick={toggleMode}>
          <Icon name={selectMode ? "close" : "check"} size={12} />
          {selectMode ? "Exit select" : "Select"}
        </button>
      </div>

      <div className="table-wrap">
        <table className="data docs-data">
          <thead>
            <tr>
              {selectMode ? (
                <th className="select-cell">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label={allSelected ? "Deselect all documents" : "Select all documents"}
                  />
                </th>
              ) : null}
              <th>Document</th>
              <th>Vacancy</th>
              <th>Version</th>
              <th>ATS</th>
              <th>Quality</th>
              <th>Status</th>
              <th>Created</th>
              <th>Expires</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => {
              const title = doc.kind === "tailored_cv" ? "Tailored CV" : "Cover letter";
              return (
                <tr key={doc.id} className={selected.has(doc.id) ? "is-selected" : undefined}>
                  {selectMode ? (
                    <td className="select-cell">
                      <input
                        type="checkbox"
                        checked={selected.has(doc.id)}
                        onChange={() => toggle(doc.id)}
                        aria-label={`Select ${title} for ${doc.title ?? "this vacancy"}`}
                      />
                    </td>
                  ) : null}
                  <td>
                    <div className="doc-cell">
                      <span className={`file-glyph ${doc.mime.includes("pdf") ? "is-pdf" : "is-docx"}`}>
                        {doc.mime.includes("pdf") ? "PDF" : "DOCX"}
                      </span>
                      <span>
                        <span className="cell-title">{title}</span>
                        <span className="cell-sub block">{formatBytes(doc.size_bytes)} · {doc.display_name.split("·")[0].trim()}</span>
                      </span>
                    </div>
                  </td>
                  <td>
                    {doc.job_id ? (
                      <Link href={`/jobs/${doc.job_id}`} className="table-link">
                        <span className="cell-title">{doc.title}</span>
                        <span className="cell-sub block">{doc.company}</span>
                      </Link>
                    ) : "—"}
                  </td>
                  <td className="num">v{doc.version}</td>
                  <td>
                    <span className="score-pill">{doc.ats_score ?? "—"}<small>/100</small></span>
                  </td>
                  <td>
                    {doc.quality_status ? (
                      <span className={`badge ${doc.quality_status === "passed" ? "badge-good" : doc.quality_status === "failed" ? "badge-warn" : "badge-neutral"}`}>
                        {doc.quality_status}{doc.quality_score !== null ? ` · ${doc.quality_score}` : ""}
                      </span>
                    ) : (
                      <span className="badge badge-neutral">Not checked</span>
                    )}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      <span className="badge badge-neutral">{doc.status}</span>
                      {doc.pinned ? <span className="badge badge-warn">Pinned</span> : null}
                    </div>
                  </td>
                  <td className="cell-sub">{formatDate(doc.created_at)}</td>
                  <td className="cell-sub">{doc.expires_at ? formatDate(doc.expires_at) : "No expiry"}</td>
                  <td>
                    <div className="row row-actions" style={{ justifyContent: "flex-end", gap: 4 }}>
                      <Link href={`/documents/${doc.id}`} className="btn btn-sm">Preview</Link>
                      <a href={`/api/documents/${doc.id}`} className="btn btn-sm">Download</a>
                      <form action={togglePinAction}>
                        <input type="hidden" name="id" value={doc.id} />
                        <SubmitButton className="btn btn-sm">{doc.pinned ? "Unpin" : "Pin"}</SubmitButton>
                      </form>
                      <DocumentDeleteButton id={doc.id} documentName={`${title} for ${doc.title ?? "this vacancy"}`} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="bulk-sink" aria-hidden="true">
        {documents.map((doc) => (
          <form
            key={doc.id}
            ref={(node) => {
              if (node) forms.current.set(doc.id, node);
              else forms.current.delete(doc.id);
            }}
            action={deleteDocumentAction}
          >
            <input type="hidden" name="id" value={doc.id} />
          </form>
        ))}
        <iframe name="document-delete-sink" title="Document deletion result" tabIndex={-1} />
      </div>

      {selected.size > 0 ? (
        <div className="bulk-actionbar" role="status" aria-live="polite">
          <div className="bulk-actionbar-count">
            <span className="bulk-count">{selected.size}</span>
            <span>{selected.size === 1 ? "document selected" : "documents selected"}</span>
          </div>
          <div className="row" style={{ gap: 7 }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>Clear</button>
            <button type="button" className="btn btn-sm btn-danger-solid" onClick={() => setConfirmOpen(true)}>
              <Icon name="trash" size={13} /> Delete selected
            </button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title={`Delete ${selected.size} ${selected.size === 1 ? "document" : "documents"}?`}
        description={
          <>
            The selected generated files will be removed from the workspace. Database records are retained for audit. Original CV files are not included in this
            selection and remain untouched.
          </>
        }
        confirmLabel="Delete selected"
        busy={busy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void deleteSelected()}
      />
    </>
  );
}
