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
