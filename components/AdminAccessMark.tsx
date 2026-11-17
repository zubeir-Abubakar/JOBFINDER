import { BrandMark } from "./BrandMark";

/**
 * Sign-in emblem: the Towfiq monogram inside a gradient-edged tile with a small
 * lock badge, so the login screen reads as secure access at a glance.
 */
export function AdminAccessMark({ size = 58, idPrefix = "login" }: { size?: number; idPrefix?: string }) {
  return (
    <span className="admin-emblem" style={{ width: size, height: size }} aria-hidden>
      <span className="admin-emblem-glow" />
      <BrandMark size={Math.round(size * 0.62)} idPrefix={idPrefix} />
      <span className="admin-emblem-badge">
        <svg
          viewBox="0 0 24 24"
          width="10"
          height="10"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="4.5" y="10" width="15" height="10" rx="2.5" />
          <path d="M8.5 10V7.6a3.5 3.5 0 0 1 7 0V10" />
        </svg>
      </span>
    </span>
  );
}
