import test from "node:test";
import assert from "node:assert/strict";
import { GmailProfileError, parseGmailProfile, type GmailFailureKind } from "../lib/gmail-profile.ts";

function expectFailure(fn: () => unknown, kind: GmailFailureKind): GmailProfileError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof GmailProfileError, "expected a GmailProfileError");
    assert.equal(error.kind, kind);
    return error;
  }
  assert.fail(`expected a ${kind} GmailProfileError`);
}

test("successful profile response returns the Gmail emailAddress", () => {
  const email = parseGmailProfile(200, {
    emailAddress: "qa.engineer@example.com",
    messagesTotal: 4210,
    threadsTotal: 1802,
    historyId: "998877",
  });
  assert.equal(email, "qa.engineer@example.com");
});

test("profile response without emailAddress is a clear missing-email error", () => {
  const error = expectFailure(() => parseGmailProfile(200, { messagesTotal: 12, historyId: "42" }), "missing_email");
  assert.match(error.message, /emailAddress/);
  assert.match(error.message, /Gmail API is enabled/);
});

test("expired credentials are reported as reconnection required", () => {
  const error = expectFailure(
    () => parseGmailProfile(401, { error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } }),
    "expired",
  );
  assert.match(error.message, /expired or was revoked/i);
  assert.match(error.message, /Reconnect Gmail/);
});

test("insufficient scopes name the missing permissions", () => {
  const error = expectFailure(
    () =>
      parseGmailProfile(403, {
        error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" },
      }),
    "scope",
  );
  assert.match(error.message, /gmail\.readonly/);
  assert.match(error.message, /gmail\.compose/);
  assert.match(error.message, /gmail\.send/);
});
