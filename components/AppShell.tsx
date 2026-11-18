"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Brand, Icon } from "./icons";
import { ThemeToggle } from "./ThemeToggle";
import { AgentAvatar } from "./AgentAvatar";
import { UserAvatar } from "./UserAvatar";
import { logoutAction } from "@/lib/actions/session";
import { CoordinatorLiveVoice } from "./CoordinatorLiveVoice";

const ownerNav = [
  { group: "Recruitment" },
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/jobs", label: "Job discovery", icon: "jobs" },
  { href: "/applications", label: "Applications", icon: "applications" },
  { group: "Workspace" },
  { href: "/documents", label: "CV & documents", icon: "docs" },
  { href: "/profile", label: "Professional profile", icon: "users" },
  { group: "Intelligence" },
  { href: "/agents", label: "AI agents", icon: "agents" },
  { href: "/analytics", label: "Analytics", icon: "analytics" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

const adminNav = [
  { group: "Administration" },
  { href: "/admin", label: "System overview", icon: "admin" },
  { href: "/admin/users", label: "User accounts", icon: "users" },
  { href: "/admin/agents", label: "Agent management", icon: "agents" },
  { href: "/admin/ai", label: "AI & API config", icon: "settings" },
  { href: "/admin/email", label: "Email & reports", icon: "mail" },
  { href: "/admin/storage", label: "Storage & retention", icon: "database" },
  { href: "/admin/security", label: "Security", icon: "shield" },
  { href: "/admin/audit", label: "Audit logs", icon: "logs" },
];

export function AppShell({
  children,
  user,
  variant = "app",
  unreadCount = 0,
  assistantMessages = [],
}: {
  children: React.ReactNode;
  user: { name: string; email: string; role: string; avatarUrl?: string | null };
  variant?: "app" | "admin";
  unreadCount?: number;
  assistantMessages?: Array<{ id: number; role: string; content: string; created_at: string }>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const nav = variant === "admin" ? adminNav : ownerNav;
  const home = variant === "admin" ? "/admin" : "/dashboard";

  return (
    <div className="shell">
      {open ? (
        <button
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          style={{ border: 0 }}
        />
      ) : null}
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <Brand href={home} />
        <nav className="flex flex-col gap-0.5 overflow-y-auto">
          {nav.map((item, index) =>
            "group" in item ? (
              <div key={`g-${index}`} className="nav-group-label">
                {item.group}
              </div>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={`nav-link ${pathname === item.href || (item.href !== "/admin" && item.href !== "/dashboard" && pathname.startsWith(item.href)) ? "active" : ""}`}
              >
                <Icon name={item.icon!} />
                {item.label}
              </Link>
            ),
          )}
        </nav>
        <div className="mt-auto">
          <div className="card-quiet p-3">
            <div className="flex items-center gap-2">
              <UserAvatar name={user.name} src={user.avatarUrl} size={30} />
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-semibold">{user.name}</div>
                <div className="truncate text-[11px]" style={{ color: "var(--muted)" }}>
                  {user.role === "admin" ? "Administrator" : "Account owner"}
                </div>
              </div>
            </div>
            <form action={logoutAction} className="mt-2.5">
              <button type="submit" className="btn btn-sm w-full justify-start">
                <Icon name="logout" /> Sign out
              </button>
            </form>
          </div>
          <p className="mt-3 px-1 text-[10.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
            {variant === "admin" ? "Restricted console — admin role only." : "Private workspace. CV data never goes public."}
          </p>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-ghost btn-sm mobile-only" onClick={() => setOpen(true)} aria-label="Open navigation">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--muted)" }}>
              {variant === "admin" ? "Administrator console" : "Recruitment operations"}
            </span>
          </div>
          <div className="header-actions">
            {variant === "app" ? <CoordinatorLiveVoice initialMessages={assistantMessages} /> : null}
            {variant === "admin" ? (
              <Link href="/dashboard" className="btn btn-ghost btn-sm">
                Owner workspace
              </Link>
            ) : user.role === "admin" ? (
              <Link href="/admin" className="btn btn-ghost btn-sm">
                Admin console
              </Link>
            ) : null}
            <ThemeToggle />
            <span className="badge badge-neutral header-account" title={`${user.name} · ${user.email}`}>
              <UserAvatar name={user.name} src={user.avatarUrl} size={18} />
              <span>{user.email}</span>
            </span>
            {variant === "app" ? (
              <>
                <Link
                  href="/inbox"
                  className="header-cta header-inbox"
                  aria-label={unreadCount > 0 ? `Inbox, ${unreadCount} unread message${unreadCount === 1 ? "" : "s"}` : "Inbox"}
                >
                  <Icon name="mail" size={15} />
                  <span className="header-cta-label">Inbox</span>
                  {unreadCount > 0 ? <span className="header-unread" aria-hidden>{unreadCount > 9 ? "9+" : unreadCount}</span> : null}
                </Link>
                <Link href="/assistant" className="header-cta header-ai" aria-label="AI Assistance">
                  <AgentAvatar agentKey="coordinator" status="idle" size={26} />
                  <span className="header-cta-label">AI Assistance</span>
                </Link>
              </>
            ) : null}
          </div>
        </header>
        <div className="page">{children}</div>
      </div>
    </div>
  );
}
