"use client";

import { useRef, useState } from "react";
import { LANGUAGE_LEVELS, type LanguageEntry } from "@/lib/profile-options";
import { saveLanguagesAction } from "@/lib/actions/profile";
import { SubmitButton } from "./SubmitButton";
import { Icon } from "./icons";

type Row = LanguageEntry & { key: string };

let rowSequence = 0;
function makeRow(entry?: LanguageEntry): Row {
  rowSequence += 1;
  return { key: `lang-${rowSequence}`, name: entry?.name ?? "", level: entry?.level ?? "unspecified" };
}

export function LanguageEditor({ initial }: { initial: LanguageEntry[] }) {
  const [rows, setRows] = useState<Row[]>(() => initial.map((entry) => makeRow(entry)));
  const [error, setError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  function notifyFormChanged() {
    requestAnimationFrame(() => formRef.current?.dispatchEvent(new Event("input", { bubbles: true })));
  }

  function update(key: string, patch: Partial<LanguageEntry>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    setError("");
  }

  function add() {
    setRows((current) => [...current, makeRow()]);
    notifyFormChanged();
  }

  function remove(key: string) {
    setRows((current) => (current.length > 1 ? current.filter((row) => row.key !== key) : current));
    setError("");
    notifyFormChanged();
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    const names = rows.map((row) => row.name.trim().toLowerCase()).filter(Boolean);
    if (new Set(names).size !== names.length) {
      event.preventDefault();
      setError("Each language can only appear once. Edit the duplicate before saving.");
      return;
    }
    setError("");
  }

  return (
    <form ref={formRef} action={saveLanguagesAction} onSubmit={submit} className="stack" style={{ gap: 8 }}>
      {rows.length === 0 ? (
        <div className="empty" style={{ padding: "20px 12px" }}>
          <strong>No languages yet</strong>
          Add the languages you can actually use; nothing is assumed from your name or location.
        </div>
      ) : (
        <div className="stack" style={{ gap: 7 }}>
          {rows.map((row, index) => (
            <div key={row.key} className="language-row">
              <div className="min-w-0 flex-1">
                <label className="label" htmlFor={`${row.key}-name`}>Language {index + 1}</label>
                <input
                  id={`${row.key}-name`}
                  name="language_name"
                  className="input"
                  value={row.name}
                  onChange={(event) => update(row.key, { name: event.target.value })}
                  placeholder="e.g. English"
                  autoComplete="off"
                />
              </div>
              <div className="language-level">
                <label className="label" htmlFor={`${row.key}-level`}>Proficiency</label>
                <select
                  id={`${row.key}-level`}
                  name="language_level"
                  className="select"
                  value={row.level}
                  onChange={(event) => update(row.key, { level: event.target.value as LanguageEntry["level"] })}
                >
                  {LANGUAGE_LEVELS.map((level) => (
                    <option key={level.value} value={level.value}>{level.label}</option>
                  ))}
                </select>
              </div>
              {rows.length > 1 ? (
                <button
                  type="button"
                  className="btn btn-sm btn-danger language-remove"
                  onClick={() => remove(row.key)}
                  aria-label={`Remove ${row.name || `language ${index + 1}`}`}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {error ? <p className="alert alert-error" role="alert">{error}</p> : null}
      <div className="row">
        <button type="button" className="btn btn-sm" onClick={add}>
          <Icon name="plus" size={12} /> Add language
        </button>
        {rows.length > 0 ? (
          <SubmitButton className="btn btn-primary btn-sm" pendingLabel="Saving…">Save languages</SubmitButton>
        ) : null}
      </div>
      <p className="hint">Levels are shown on generated CVs. “Level not specified” is kept honest until you choose one.</p>
    </form>
  );
}
