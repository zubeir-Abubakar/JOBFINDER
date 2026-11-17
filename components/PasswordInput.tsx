"use client";

import { useState, type ChangeEvent } from "react";

export function PasswordInput({
  id,
  name,
  autoComplete,
  required = false,
  minLength,
  placeholder,
  value,
  onChange,
  describedBy,
}: {
  id: string;
  name: string;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  placeholder?: string;
  value?: string;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  describedBy?: string;
}) {
  const [visible, setVisible] = useState(false);
  const label = visible ? "Hide password" : "Show password";

  return (
    <div className="password-field">
      <input
        id={id}
        name={name}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        className="input password-input"
        aria-describedby={describedBy}
      />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setVisible((current) => !current)}
        aria-label={label}
        aria-pressed={visible}
        title={label}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {visible ? (
            <>
              <path d="M3 3l18 18" />
              <path d="M10.6 10.7a2 2 0 0 0 2.7 2.7" />
              <path d="M9.4 5.3A10.8 10.8 0 0 1 12 5c5.2 0 9 5.2 9 7a12.8 12.8 0 0 1-3 3.7" />
              <path d="M6.2 6.3C4.2 7.7 3 9.5 3 12c0 1.8 3.8 7 9 7 1.4 0 2.7-.4 3.8-1" />
            </>
          ) : (
            <>
              <path d="M3 12c0-1.8 3.8-7 9-7s9 5.2 9 7-3.8 7-9 7-9-5.2-9-7z" />
              <circle cx="12" cy="12" r="2.6" />
            </>
          )}
        </svg>
      </button>
    </div>
  );
}
