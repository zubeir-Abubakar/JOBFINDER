import Link from "next/link";

/** Shared switch between the canonical live topology and the existing roster. */
export function AgentsViewSwitch({ active }: { active: "list" | "topology" }) {
  return (
    <nav className="agents-view-switch" aria-label="Agents views">
      <Link
        href="/agents"
        className={active === "topology" ? "is-active" : ""}
        aria-current={active === "topology" ? "page" : undefined}
      >
        Live topology
      </Link>
      <Link
        href="/agents/list"
        className={active === "list" ? "is-active" : ""}
        aria-current={active === "list" ? "page" : undefined}
      >
        List view
      </Link>
    </nav>
  );
}
