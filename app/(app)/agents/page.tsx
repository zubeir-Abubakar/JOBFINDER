import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getAgentTopologySnapshot } from "@/lib/agent-topology";
import { AgentTopology } from "@/components/AgentTopology";
import { AgentsViewSwitch } from "@/components/AgentsViewSwitch";
import { PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const user = await requireUser();
  const snapshot = getAgentTopologySnapshot(user);

  return (
    <>
      <PageHead
        title="Live agent topology"
        sub="Central command view of the existing workforce. States, tasks, connections and the timeline are read from persisted execution records."
        actions={
          <>
            <Link href="/recruitment" className="btn">Recruitment runs</Link>
            <Link href="/agents/list" className="btn">Manage agents</Link>
          </>
        }
      />
      <AgentsViewSwitch active="topology" />
      <AgentTopology initialSnapshot={snapshot} />
    </>
  );
}
