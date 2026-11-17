/**
 * Text extraction for uploaded CVs. DOCX is parsed with mammoth, PDF with
 * unpdf. Nothing is sent to an external service.
 */
export async function extractText(buffer: Buffer, mime: string, fileName: string): Promise<string> {
  const lower = fileName.toLowerCase();
  if (mime.includes("wordprocessingml") || lower.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return normalise(result.value);
  }
  if (mime === "application/pdf" || lower.endsWith(".pdf")) {
    const { extractText: extractPdf, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractPdf(pdf, { mergePages: true });
    const text = Array.isArray(result.text) ? result.text.join("\n") : result.text;
    return normalise(text);
  }
  if (mime === "text/plain" || lower.endsWith(".txt") || lower.endsWith(".md")) {
    return normalise(buffer.toString("utf8"));
  }
  throw new Error("Unsupported file type. Upload a PDF, DOCX or plain text file.");
}

function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type ExtractedFields = {
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  name: string | null;
  skills: string[];
  companies: string[];
  evidence: Record<string, string>;
};

const KNOWN_SKILLS = [
  "Playwright",
  "Cypress",
  "Selenium",
  "Appium",
  "Espresso",
  "XCUITest",
  "REST Assured",
  "Postman",
  "Swagger",
  "Python",
  "JavaScript",
  "TypeScript",
  "Java",
  "SQL",
  "Jenkins",
  "Azure DevOps",
  "Docker",
  "Git",
  "CI/CD",
  "JMeter",
  "k6",
  "Grafana",
  "Jira",
  "Xray",
  "QA Touch",
  "TestRail",
  "Cucumber",
  "BDD",
  "Kotlin",
  "Swift",
  "AWS",
  "Azure",
  "Kubernetes",
];

/** Conservative extraction: only surfaces values that literally appear in the CV. */
export function extractFields(text: string): ExtractedFields {
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? null;
  const phone =
    text.match(/(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s./-]?){3,5}\d{2,4}/)?.[0]?.trim() ?? null;
  const linkedin = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[^\s|,)]+/i)?.[0] ?? null;
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 2 && l.length < 60 && !l.includes("@") && !/\d{3}/.test(l));
  const skills = KNOWN_SKILLS.filter((skill) => new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
  const companies = ["Cashia", "Nobilis", "Safaricom"].filter((c) => new RegExp(c, "i").test(text));

  return {
    email,
    phone,
    linkedin: linkedin ? (linkedin.startsWith("http") ? linkedin : `https://${linkedin}`) : null,
    name: firstLine && /^[A-Z][A-Za-z.'-]+(\s+[A-Z][A-Za-z.'-]+){1,3}$/.test(firstLine) ? firstLine : null,
    skills,
    companies,
    evidence: {
      email: email ? "matched in CV text" : "not found",
      phone: phone ? "matched in CV text" : "not found",
      skills: `${skills.length} recognised technologies found`,
    },
  };
}
