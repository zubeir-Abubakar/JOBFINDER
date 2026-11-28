import test from "node:test";
import assert from "node:assert/strict";
import {
  GmailProfileError,
  gmailFailureCode,
  gmailTokenRefreshError,
  parseGmailProfile,
  type GmailFailureKind,
} from "../lib/gmail-profile.ts";

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

test("a dead refresh grant is classified as invalid_grant and requires a reconnection", () => {
  const error = gmailTokenRefreshError(400, "invalid_grant", "Token has been expired or revoked.");
  assert.equal(error.kind, "invalid_grant");
  assert.equal(error.status, 400);
  assert.equal(gmailFailureCode(error.kind), "invalid_grant");
  assert.match(error.message, /Reconnect Gmail/);
  assert.match(error.message, /expired or was revoked/i);
  assert.match(error.message, /retrying this message cannot succeed/i);
});

test("a temporary token-endpoint outage stays retryable and does not demand a reconnection", () => {
  const unavailable = gmailTokenRefreshError(503, "temporarily_unavailable", "Backend error");
  assert.equal(unavailable.kind, "transient");
  assert.equal(gmailFailureCode(unavailable.kind), "refresh_transient");
  assert.match(unavailable.message, /retries it automatically/i);
  assert.doesNotMatch(unavailable.message, /Reconnect Gmail/);
  assert.notEqual(gmailFailureCode("transient"), gmailFailureCode("invalid_grant"));

  const network = gmailTokenRefreshError(null, null, "fetch failed");
  assert.equal(network.kind, "transient");

  const rateLimited = gmailTokenRefreshError(429, "rate_limit_exceeded");
  assert.equal(rateLimited.kind, "transient");
});

test("a rejected OAuth client is a configuration fault, not a dead grant", () => {
  const error = gmailTokenRefreshError(401, "invalid_client", "Unauthorized");
  assert.equal(error.kind, "config");
  assert.equal(gmailFailureCode(error.kind), "refresh_config");
  assert.match(error.message, /GOOGLE_CLIENT_ID/);
  assert.doesNotMatch(error.message, /expired or was revoked/i);
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
