import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Minimal, dependency-free MIME builder for Gmail's raw send endpoint.
 *
 * The HTML part and the plain-text part are both present, so a client that does
 * not render HTML still receives the complete report. The logo is attached
 * inline with a Content-ID; external image hosting and data: URIs are not used.
 */

export type EmailMimeInput = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  /** A stable Message-ID lets a retry prove whether the first send was accepted. */
  messageId?: string | null;
  /** Defaults to Logo.jpeg in the project root. */
  logoPath?: string | null;
};

export type EmailMimeResult = {
  /** base64url value for Gmail's `raw` field. */
  raw: string;
  usedLogo: boolean;
  rfcMessageId: string;
};

function header(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 998);
}

function encodedHeader(value: string): string {
  return `=?UTF-8?B?${Buffer.from(header(value), "utf8").toString("base64")}?=`;
}

function base64Body(value: string | Buffer): string {
  const encoded = Buffer.isBuffer(value)
    ? value.toString("base64")
    : Buffer.from(value, "utf8").toString("base64");
  return encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

const relatedBoundary = "atw-related-boundary";
const alternativeBoundary = "atw-alternative-boundary";

export function buildEmailMime(input: EmailMimeInput): EmailMimeResult {
  const logoPath = input.logoPath ?? path.join(process.cwd(), "Logo.jpeg");
  const html = input.html?.trim() ? input.html : null;
  const usedLogo = Boolean(html && existsSync(/* turbopackIgnore: true */ logoPath));
  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(input.text),
  ].join("\r\n");
  const htmlPart = html
    ? [
        'Content-Type: text/html; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        base64Body(html),
      ].join("\r\n")
    : null;

  const from = header(input.from || "AT AI Workforce");
  const domain = from.match(/@([^>\s]+)/)?.[1] ?? "atw.local";
  const rfcMessageId = header(input.messageId ?? `<atw-${crypto.randomUUID()}@${domain}>`);
  const headers = [
    `From: ${from}`,
    `To: ${header(input.to)}`,
    `Subject: ${encodedHeader(input.subject)}`,
    `Message-ID: ${rfcMessageId}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
  ];

  let body: string;
  if (htmlPart && usedLogo) {
    const logo = readFileSync(/* turbopackIgnore: true */ logoPath);
    const logoPart = [
      'Content-Type: image/jpeg; name="atw-logo.jpg"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: inline; filename="atw-logo.jpg"',
      "Content-ID: <atw-logo>",
      "Content-Location: atw-logo.jpg",
      "",
      base64Body(logo),
    ].join("\r\n");
    headers.push(`Content-Type: multipart/related; boundary="${relatedBoundary}"`);
    body = [
      `--${relatedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
      "",
      `--${alternativeBoundary}`,
      textPart,
      "",
      `--${alternativeBoundary}`,
      htmlPart,
      "",
      `--${alternativeBoundary}--`,
      "",
      `--${relatedBoundary}`,
      logoPart,
      "",
      `--${relatedBoundary}--`,
      "",
    ].join("\r\n");
  } else if (htmlPart) {
    headers.push(`Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`);
    body = [
      `--${alternativeBoundary}`,
      textPart,
      "",
      `--${alternativeBoundary}`,
      htmlPart,
      "",
      `--${alternativeBoundary}--`,
      "",
    ].join("\r\n");
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");
    body = `${base64Body(input.text)}\r\n`;
  }

  const message = `${headers.join("\r\n")}\r\n\r\n${body}`;
  return { raw: Buffer.from(message, "utf8").toString("base64url"), usedLogo, rfcMessageId };
}

/** Decode a generated raw message for tests and local previews. */
export function decodeMime(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}
