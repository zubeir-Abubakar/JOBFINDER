import test from "node:test";
import assert from "node:assert/strict";

import { agentIdentity } from "../lib/agent-identity.ts";
import { WORKFLOW_STAGES, workflowOrderLabel } from "../lib/workflow-stages.ts";

test("the workflow chart follows the required owner-facing order", () => {
  assert.deepEqual(
    WORKFLOW_STAGES.map((stage) => stage.label),
    ["Chief", "Saffa", "Ali", "Kora & Amira", "Kali", "Noor", "Rayna"],
  );
  assert.deepEqual(
    WORKFLOW_STAGES.flatMap((stage) => stage.agents),
    ["coordinator", "research", "analysis", "cv", "cover", "ats", "application", "email"],
  );
  assert.equal(workflowOrderLabel(), "Chief → Saffa → Ali → Kora → Amira → Kali → Noor → Rayna");
});

test("workflow nodes use the registry names and titles, with one approval gate", () => {
  const byKey = new Map(WORKFLOW_STAGES.map((stage) => [stage.key, stage]));
  assert.equal(byKey.get("coordinator")?.label, agentIdentity("coordinator").name);
  assert.match(byKey.get("generation")?.hint ?? "", /CV Optimisation Agent \/ Documents/);
  assert.match(byKey.get("quality")?.hint ?? "", /ATS Quality Control Agent/);
  assert.equal(byKey.get("submission")?.label, agentIdentity("application").name);
  assert.equal(byKey.get("tracking")?.label, agentIdentity("email").name);
  assert.deepEqual(
    WORKFLOW_STAGES.filter((stage) => stage.approvalGate).map((stage) => stage.key),
    ["submission"],
  );
});
