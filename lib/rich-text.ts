const ALLOWED_TAGS = new Set(["b", "strong", "u", "em", "i", "ul", "ol", "li", "p", "div", "br"]);

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'");
}

/** Small allow-list sanitiser for the role editors. No scripts, styles, attributes or external URLs survive. */
export function sanitizeRichText(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|svg|math)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\s*(\/?)\s*([a-zA-Z][\w-]*)(?:\s[^>]*)?\s*\/?>/g, (_match, closing: string, rawTag: string) => {
      const tag = rawTag.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return "";
      if (tag === "br") return "<br>";
      return `<${closing ? "/" : ""}${tag}>`;
    })
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, 30_000);
}

export function richTextToPlain(value: string | null | undefined): string {
  if (!value) return "";
  return decodeEntities(
    value
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/\s*(p|div|li|ul|ol)\s*>/gi, "\n")
      .replace(/<\s*li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, lines) => line || (index > 0 && index < lines.length - 1))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function escapeHtml(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Turns a plain textarea value into paragraphs for the rich editor without pretending it was formatted HTML. */
export function plainTextToHtml(value: string | null | undefined): string {
  const text = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return "";
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** One bullet per line, suitable for the achievements editor. */
export function listToHtml(values: string[]): string {
  const items = values.map((value) => value.trim()).filter(Boolean);
  if (items.length === 0) return "";
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

/** Extracts every meaningful line or list item, so paragraphs and bullets both survive an edit. */
export function richTextToBullets(value: string | null | undefined): string[] {
  if (!value) return [];
  return richTextToPlain(value)
    .split(/\n+/)
    .map((item) => item.replace(/^\s*[-•●▪◦*]\s*/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}
