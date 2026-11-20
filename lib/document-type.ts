import path from "node:path";

export type DetectedDocumentType = {
  mime: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "text/plain";
  extension: ".pdf" | ".docx" | ".txt";
  kind: "pdf" | "docx" | "text";
};

function hasBytes(buffer: Buffer, expected: number[], offset = 0): boolean {
  if (buffer.length < offset + expected.length) return false;
  return expected.every((value, index) => buffer[offset + index] === value);
}

/**
 * Validate the file by extension plus content signature. The browser-supplied
 * MIME type is never authoritative: it is attacker-controlled and has been
 * used to make an HTML file look like a PDF.
 */
export function detectDocumentType(buffer: Buffer, fileName: string): DetectedDocumentType | null {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".pdf" && buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return { mime: "application/pdf", extension: ".pdf", kind: "pdf" };
  }
  if (extension === ".docx" && hasBytes(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    return {
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extension: ".docx",
      kind: "docx",
    };
  }
  if (extension === ".txt" && !buffer.includes(0) && buffer.length <= 8 * 1024 * 1024) {
    return { mime: "text/plain", extension: ".txt", kind: "text" };
  }
  return null;
}

/** Never echo an uploaded document's declared MIME back to the browser. */
export function safeDocumentMime(fileName: string, declaredMime: string | null): string {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (extension === ".txt") return "text/plain";
  const declared = (declaredMime ?? "").toLowerCase();
  if (declared === "application/pdf") return "application/pdf";
  if (declared === "text/plain") return "text/plain";
  if (declared.includes("wordprocessingml")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "application/octet-stream";
}
