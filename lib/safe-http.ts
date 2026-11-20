import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { assertPublicHttpUrl, isPublicAddress } from "./outbound-url";

export type ResolvedAddress = { address: string; family: number };

type LookupImpl = (
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

type SafeFetchOptions = {
  allowPrivate?: boolean;
  followRedirects?: boolean;
  maxRedirects?: number;
};

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const agents = new Map<boolean, Agent>();

function allowsPrivate(allowPrivate?: boolean): boolean {
  return (
    allowPrivate ??
    (process.env.NODE_ENV !== "production" || process.env.OUTBOUND_ALLOW_PRIVATE === "true")
  );
}

/** Resolve and filter every address before the socket connects. */
export async function resolvePublicAddresses(
  hostname: string,
  options: { allowPrivate?: boolean; lookupImpl?: LookupImpl } = {},
): Promise<ResolvedAddress[]> {
  const allowPrivate = allowsPrivate(options.allowPrivate);
  const lookup = options.lookupImpl ?? (dnsLookup as unknown as LookupImpl);
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    lookup(hostname, { all: true, verbatim: true }, (error, result) => {
      if (error) reject(error);
      else resolve(Array.isArray(result) ? result : []);
    });
  });
  const allowed = addresses
    .filter((entry) => Boolean(entry.address))
    .filter((entry) => allowPrivate || isPublicAddress(entry.address));
  if (allowed.length === 0) {
    throw new Error("The outbound host resolved only to private, loopback or reserved addresses.");
  }
  return allowed.map((entry) => ({ address: entry.address, family: entry.family }));
}

function agentFor(allowPrivate: boolean): Agent {
  const existing = agents.get(allowPrivate);
  if (existing) return existing;
  const agent = new Agent({
    connect: {
      // This lookup is the one net.connect uses. The address that is validated
      // is the same address returned to the socket, so DNS rebinding cannot
      // swap a public answer for a private one between validation and connect.
      lookup(hostname: string, options: LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) {
        void resolvePublicAddresses(hostname, { allowPrivate })
          .then((addresses) => {
            const first = addresses[0];
            if (!first) throw new Error("No public address was resolved.");
            // Node's net connector requests `all` in some versions. Returning a
            // single address then makes undici read `address.address` from a
            // string and fail with ERR_INVALID_IP_ADDRESS before connecting.
            if (options?.all) callback(null, addresses);
            else callback(null, first.address, first.family);
          })
          .catch((error: unknown) => {
            const err = error instanceof Error ? error : new Error("Outbound DNS validation failed.");
            callback(Object.assign(err, { code: "EAI_BLOCKED" }) as NodeJS.ErrnoException, "", 4);
          });
      },
    },
  });
  agents.set(allowPrivate, agent);
  return agent;
}

export function validateRedirectTarget(
  location: string,
  base: string,
  options: { allowPrivate?: boolean } = {},
): string {
  const url = new URL(location, base);
  assertPublicHttpUrl(url.href, { allowPrivate: options.allowPrivate });
  return url.href;
}

function redirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Fetch a public HTTP(S) resource with destination enforcement at connect time.
 * Redirects are followed one hop at a time and revalidated. Callers that need
 * the raw 3xx response (application form POSTs) set redirect: "manual".
 */
export async function safeFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  let url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  const allowPrivate = allowsPrivate(options.allowPrivate);
  const followRedirects = options.followRedirects ?? init.redirect !== "manual";
  const maxRedirects = Math.min(10, Math.max(0, options.maxRedirects ?? MAX_REDIRECTS));
  const dispatcher = agentFor(allowPrivate);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const checked = assertPublicHttpUrl(url, { allowPrivate });
    const response = (await undiciFetch(checked, {
      ...init,
      method,
      body: body as BodyInit | undefined,
      headers,
      redirect: "manual",
      dispatcher,
    } as unknown as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    if (!followRedirects || !redirectStatus(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    await response.body?.cancel();
    url = validateRedirectTarget(location, checked.href, { allowPrivate });
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")) {
      method = "GET";
      body = undefined;
      headers.delete("content-type");
      headers.delete("content-length");
    }
  }
  throw new Error("The outbound request exceeded the redirect limit.");
}

/** Read a response without allowing an attacker-controlled body to exhaust RAM. */
export async function readLimitedText(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("The outbound response exceeded the size limit.");
  }
  if (!response.body) return (await response.text()).slice(0, maxBytes);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("The outbound response exceeded the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
