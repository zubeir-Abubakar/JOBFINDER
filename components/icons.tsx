import Link from "next/link";
import { BrandMark } from "./BrandMark";

type IconProps = { d: string };

const icons: Record<string, string> = {
  dashboard: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  jobs: "M4 8h16v11H4zM9 8V5h6v3M4 13h16",
  applications: "M6 3h9l4 4v14H6zM15 3v4h4M9 12h6M9 16h6",
  docs: "M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h4",
  agents: "M12 3v3M5 9h14v10H5zM9 13h.01M15 13h.01M9 19v2M15 19v2",
  chat: "M4 5h16v11H9l-5 4z",
  analytics: "M4 20V9M10 20V4M16 20v-7M22 20H2",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2",
  admin: "M12 3l8 4v6c0 4-3.4 7.2-8 8-4.6-.8-8-4-8-8V7z",
  users: "M8 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 21c0-3.3 2.7-6 6-6s6 2.7 6 6M17 11a3 3 0 1 0 0-6M22 21c0-2.8-1.8-5.2-4.5-5.8",
  logs: "M4 6h16M4 12h16M4 18h10",
  mail: "M3 6h18v12H3zM3 7l9 6 9-6",
  shield: "M12 3l8 4v6c0 4-3.4 7.2-8 8-4.6-.8-8-4-8-8V7z",
  logout: "M15 4h4v16h-4M11 16l-4-4 4-4M7 12h9",
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14M13 6l6 6-6 6",
  database: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6",
  filter: "M4 6h16M7 12h10M10 18h4",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  check: "M5 12l4 4L19 6",
  close: "M6 6l12 12M18 6L6 18",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v3M12 19v3M2 12h3M19 12h3",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  sparkles: "M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8zM5 3l.6 1.7L7.3 5l-1.7.6L5 7.3l-.6-1.7L2.7 5l1.7-.3z",
  chevron: "M6 9l6 6 6-6",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
};

export function Icon({ name, size = 15 }: { name: keyof typeof icons | string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={icons[name] ?? icons.dashboard} />
    </svg>
  );
}

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="brand" aria-label="Towfiq AI Agents">
      <span className="brand-logo">
        <BrandMark size={34} idPrefix="brand" />
      </span>
      <span>
        <span className="brand-name">Towfiq</span>
        <span className="brand-tag">AI Agents</span>
      </span>
    </Link>
  );
}
