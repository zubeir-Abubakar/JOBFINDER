/**
 * Credential patterns shared by the secret scanner and the history purge.
 *
 * Keeping one definition matters: the purge previously used its own,
 * unanchored regexes and rewrote ordinary identifiers that merely contained
 * those character sequences. The leading word boundary in these patterns
 * prevents a match from starting in the middle of a name.
 */

/** High-signal formats. These are enforced in every file, tests included. */
export const STRONG = [
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "Google OAuth client secret", re: /GOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI-style key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "Groq key", re: /\bgsk_[A-Za-z0-9]{20,}/ },
  { name: "Resend key", re: /\bre_[A-Za-z0-9_]{16,}/ },
  { name: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{20,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Supabase key", re: /\bsb[p]_[A-Za-z0-9_-]{20,}/ },
  { name: "private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "database URL with password", re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>:@/]{1,64}:[^\s"'<>@/]{2,64}@/ },
];

/**
 * Placeholder detection applies to the MATCHED VALUE, never to the whole line:
 * a line that merely mentions "example" must still be scanned. A real key never
 * contains these words.
 */
export const PLACEHOLDER_VALUE = /(?:placeholder|change[-_]?this|your[-_]|example|redacted|not[-_]a[-_]|dummy|sample|fixture|xxxx)/i;
/** Template expressions are not literal credentials. */
export const TEMPLATE_VALUE = /^(?:\$\{|<[^>]*>|\{\{)/;

/** Every strong-format value in a text, using the scanner's exact rules. */
export function strongValues(text) {
  const found = [];
  for (const pattern of STRONG) {
    for (const match of text.matchAll(new RegExp(pattern.re.source, `${pattern.re.flags.replace("g", "")}g`))) {
      const value = match[0];
      if (PLACEHOLDER_VALUE.test(value) || TEMPLATE_VALUE.test(value)) continue;
      found.push(value);
    }
  }
  return found;
}
