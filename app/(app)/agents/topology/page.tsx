import { redirect } from "next/navigation";

/** Legacy entry point. The topology is the canonical /agents experience. */
export default function AgentTopologyPage(): never {
  redirect("/agents");
}
