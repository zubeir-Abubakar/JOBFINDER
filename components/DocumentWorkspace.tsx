"use client";

import { useState } from "react";
import { DocumentPreview } from "./DocumentPreview";

type Doc = {
  id: string;
  label: string;
  mime: string;
  ats: number | null;
  version: string | null;
  quality: string | null;
  qualityScore: number | null;
};

/** One document is mounted at a time so a review never loads every preview. */
export function DocumentWorkspace({ documents }: { documents: Doc[] }) {
  const [active, setActive] = useState(0);
  if (documents.length === 0) {
    return (
      <div className="card-body">
        <p className="text-[12px]" style={{ color: "var(--muted)" }}>
          No documents are linked to this application yet. Generate a package from the vacancy page.
        </p>
      </div>
    );
  }
  const current = documents[Math.min(active, documents.length - 1)];
  return (
    <div className="card-body">
      <div className="doc-tabs" role="tablist" aria-label="Application documents">
        {documents.map((doc, index) => (
          <button
            key={doc.id}
            type="button"
            role="tab"
            aria-selected={index === active}
            className={`doc-tab ${index === active ? "active" : ""}`}
            onClick={() => setActive(index)}
          >
            {doc.label}
            {doc.version ? <span className="doc-tab-version">v{doc.version}</span> : null}
            {doc.ats !== null ? <span className="doc-tab-ats">{doc.ats}/100</span> : null}
            {doc.quality ? <span className={`doc-tab-ats ${doc.quality === "failed" ? "text-red-600" : ""}`}>{doc.quality}</span> : null}
          </button>
        ))}
      </div>
      <DocumentPreview key={current.id} id={current.id} name={`${current.label}.${current.mime.includes("pdf") ? "pdf" : "docx"}`} mime={current.mime} />
    </div>
  );
}
