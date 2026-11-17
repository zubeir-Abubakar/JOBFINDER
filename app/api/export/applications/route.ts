import { currentUser } from "@/lib/auth";
import { all } from "@/lib/db";

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
}

export async function GET() {
  const user = await currentUser();
  if (!user) return new Response("Unauthorised", { status: 401 });

  const rows = all<Record<string, unknown>>(
    `SELECT a.id, j.company, j.title, j.location, j.url, a.status, a.method, a.confirmation,
            a.submitted_at, a.last_update, a.notes,
            (SELECT display_name FROM documents d WHERE d.id = a.cv_document_id) AS cv,
            (SELECT display_name FROM documents d WHERE d.id = a.cover_letter_id) AS cover_letter
     FROM applications a JOIN jobs j ON j.id = a.job_id ORDER BY a.created_at DESC`,
  );

  const headers = [
    "Application ID",
    "Employer",
    "Position",
    "Location",
    "Job URL",
    "Status",
    "Submission method",
    "Confirmation",
    "Submitted at",
    "Last update",
    "CV version",
    "Cover letter",
    "Notes",
  ];
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.company,
        row.title,
        row.location,
        row.url,
        row.status,
        row.method,
        row.confirmation,
        row.submitted_at,
        row.last_update,
        row.cv,
        row.cover_letter,
        row.notes,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response("\uFEFF" + lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="at-ai-workforce-applications-${stamp}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
