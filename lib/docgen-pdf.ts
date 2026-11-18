import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { CoverDocModel, CvDocModel } from "./document-model";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BLUE = rgb(0.043, 0.447, 0.725);
const INK = rgb(0.09, 0.12, 0.16);
const MUTED = rgb(0.34, 0.38, 0.44);
const RULE = rgb(0.42, 0.46, 0.51);
const LIGHT_RULE = rgb(0.76, 0.79, 0.82);
type Color = ReturnType<typeof rgb>;

type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont };

type TextOptions = {
  font?: PDFFont;
  size?: number;
  color?: Color;
  lineHeight?: number;
  after?: number;
  indent?: number;
  x?: number;
  maxWidth?: number;
};

function safe(value: string): string {
  return value
    .replace(/[–—]/g, "-")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[•●▪◦]/g, "")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const value = safe(text).replace(/\s+/g, " ").trim();
  if (!value) return [""];
  const words = value.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);

  // A very long URL or token must not overflow the page.
  return lines.flatMap((line) => {
    if (font.widthOfTextAtSize(line, size) <= maxWidth) return [line];
    const chunks: string[] = [];
    let chunk = "";
    for (const char of line) {
      if (font.widthOfTextAtSize(chunk + char, size) > maxWidth && chunk) {
        chunks.push(chunk);
        chunk = char;
      } else {
        chunk += char;
      }
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  });
}

class PdfWriter {
  private pages: PDFPage[] = [];
  private y = PAGE_HEIGHT - MARGIN;

  constructor(
    private readonly pdf: PDFDocument,
    private readonly fonts: Fonts,
    private readonly name: string,
  ) {
    this.newPage();
  }

  private get page(): PDFPage {
    return this.pages[this.pages.length - 1];
  }

  private newPage(): void {
    const page = this.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(page);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  private ensure(space: number): void {
    if (this.y - space < MARGIN) this.newPage();
  }

  text(value: string, options: TextOptions = {}): void {
    const font = options.font ?? this.fonts.regular;
    const size = options.size ?? 10;
    const color = options.color ?? INK;
    const lineHeight = options.lineHeight ?? size * 1.35;
    const x = options.x ?? MARGIN;
    const maxWidth = options.maxWidth ?? CONTENT_WIDTH - (options.indent ?? 0);
    const lines = wrapText(value, font, size, maxWidth);
    this.ensure(lines.length * lineHeight + (options.after ?? 0));
    for (const line of lines) {
      this.page.drawText(line, { x: x + (options.indent ?? 0), y: this.y, size, font, color });
      this.y -= lineHeight;
    }
    this.y -= options.after ?? 0;
  }

  rule(after = 7, color: Color = RULE, thickness = 0.9): void {
    this.ensure(after + 2);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y + 2 },
      end: { x: PAGE_WIDTH - MARGIN, y: this.y + 2 },
      thickness,
      color,
    });
    this.y -= after;
  }

  heading(label: string): void {
    this.ensure(32);
    this.y -= 2;
    this.page.drawText(safe(label.toUpperCase()), {
      x: MARGIN,
      y: this.y,
      size: 10.8,
      font: this.fonts.bold,
      color: BLUE,
    });
    this.y -= 4;
    this.rule(10);
  }

  row(left: string, right: string, leftBold = true, leftSize = 10.2, rightSize = 9.2): void {
    const leftFont = leftBold ? this.fonts.bold : this.fonts.regular;
    const rightWidth = this.fonts.italic.widthOfTextAtSize(safe(right), rightSize);
    const maxLeft = CONTENT_WIDTH - rightWidth - 14;
    const leftLines = wrapText(left, leftFont, leftSize, maxLeft);
    const lineHeight = leftSize * 1.3;
    this.ensure(Math.max(leftLines.length * lineHeight, rightSize * 1.3));
    leftLines.forEach((line, index) => {
      this.page.drawText(line, {
        x: MARGIN,
        y: this.y - index * lineHeight,
        size: leftSize,
        font: leftFont,
        color: BLUE,
      });
    });
    this.page.drawText(safe(right), {
      x: PAGE_WIDTH - MARGIN - rightWidth,
      y: this.y,
      size: rightSize,
      font: this.fonts.italic,
      color: MUTED,
    });
    this.y -= leftLines.length * lineHeight;
  }

  bullet(value: string, size = 9.7): void {
    const font = this.fonts.regular;
    const lineHeight = size * 1.28;
    const lines = wrapText(value, font, size, CONTENT_WIDTH - 13);
    this.ensure(lines.length * lineHeight + 1);
    this.page.drawCircle({ x: MARGIN + 3, y: this.y - size * 0.35, size: 1.65, color: INK });
    lines.forEach((line, index) => {
      this.page.drawText(line, {
        x: MARGIN + 13,
        y: this.y - index * lineHeight,
        size,
        font,
        color: INK,
      });
    });
    this.y -= lines.length * lineHeight + 1.2;
  }

  skill(label: string, values: string): void {
    const labelFont = this.fonts.bold;
    const valueFont = this.fonts.regular;
    const size = 9.25;
    const lineHeight = 12.1;
    const labelWidth = 166;
    const labelX = MARGIN;
    const valueX = MARGIN + 178;
    const labelLines = wrapText(`${label}:`, labelFont, size, labelWidth);
    const valueLines = wrapText(values, valueFont, size, CONTENT_WIDTH - 154);
    const count = Math.max(labelLines.length, valueLines.length);
    this.ensure(count * lineHeight + 2.2);
    for (let index = 0; index < count; index += 1) {
      if (labelLines[index]) {
        this.page.drawText(labelLines[index], { x: labelX, y: this.y - index * lineHeight, size, font: labelFont, color: BLUE });
      }
      if (valueLines[index]) {
        this.page.drawText(valueLines[index], { x: valueX, y: this.y - index * lineHeight, size, font: valueFont, color: INK });
      }
    }
    this.y -= count * lineHeight + 2.2;
  }

  space(value: number): void {
    this.y -= value;
  }

  /** Keep a role header and at least two bullets together on one page. */
  reserve(value: number): void {
    this.ensure(value);
  }

  header(name: string, headline: string, contact: string[], permit: string | null): void {
    this.text(name.toUpperCase(), {
      font: this.fonts.bold,
      size: Math.min(23, 23),
      color: BLUE,
      lineHeight: 25,
      after: 1,
    });
    if (headline) this.text(headline, { font: this.fonts.regular, size: 10.1, color: BLUE, lineHeight: 13, after: 1 });
    if (contact.length) this.text(contact.join(" | "), { font: this.fonts.regular, size: 8.9, color: INK, lineHeight: 11.8, after: 0 });
    if (permit) this.text(permit, { font: this.fonts.regular, size: 8.7, color: MUTED, lineHeight: 11.5, after: 0 });
    this.y -= 4;
    this.rule(9);
  }

  finish(withFooter = true): void {
    if (!withFooter) return;
    const total = this.pages.length;
    this.pages.forEach((page, index) => {
      page.drawLine({
        start: { x: MARGIN, y: 40 },
        end: { x: PAGE_WIDTH - MARGIN, y: 40 },
        thickness: 0.5,
        color: LIGHT_RULE,
      });
      page.drawText(safe(this.name.toUpperCase()), { x: MARGIN, y: 28, size: 7.2, font: this.fonts.regular, color: MUTED });
      const label = `Page ${index + 1} of ${total}`;
      const width = this.fonts.regular.widthOfTextAtSize(label, 7.2);
      page.drawText(label, { x: PAGE_WIDTH - MARGIN - width, y: 28, size: 7.2, font: this.fonts.regular, color: MUTED });
    });
  }
}

async function fontsFor(pdf: PDFDocument): Promise<Fonts> {
  return {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
  };
}

export async function renderCvPdf(model: CvDocModel): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const fonts = await fontsFor(pdf);
  const writer = new PdfWriter(pdf, fonts, model.name);
  writer.header(model.name, model.headline, model.contact, model.permit);

  writer.heading("Professional Summary");
  writer.text(model.summary, { size: 10.15, lineHeight: 14.1, after: 4 });

  writer.heading("Technical Skills");
  for (const group of model.skillGroups) writer.skill(group.label, group.values.join(", "));

  writer.heading("Professional Experience");
  for (const role of model.roles) {
    writer.reserve(role.note ? 96 : 82);
    writer.space(2);
    writer.row(role.title, role.dates);
    const company = `${role.company}${role.location ? `, ${role.location}` : ""}`;
    writer.text(company, { font: fonts.bold, size: 9.9, color: BLUE, lineHeight: 12.3, after: 0 });
    if (role.summary) writer.text(role.summary, { size: 9.7, lineHeight: 12.4, after: 2 });
    if (role.note) writer.text(role.note, { font: fonts.italic, size: 9.2, color: MUTED, lineHeight: 11.8, after: 0 });
    for (const bullet of role.bullets) writer.bullet(bullet);
    if (role.projects) writer.text(`Projects: ${role.projects}`, { font: fonts.italic, size: 9.2, color: MUTED, lineHeight: 11.8, after: 1 });
    writer.space(5);
  }

  if (model.certifications.length) {
    writer.heading("Certifications");
    for (const certification of model.certifications) writer.bullet(certification);
  }
  if (model.education.length) {
    writer.heading("Education");
    for (const item of model.education) {
      writer.row(item.title, item.date ?? "");
      if (item.institution) writer.text(item.institution, { font: fonts.italic, size: 9.4, color: MUTED, lineHeight: 12, after: 3 });
    }
  }
  if (model.languages) {
    writer.heading("Languages");
    writer.text(model.languages, { size: 9.7, lineHeight: 13 });
  }

  writer.finish(true);
  return Buffer.from(await pdf.save());
}

export async function renderCoverPdf(model: CoverDocModel): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const fonts = await fontsFor(pdf);
  const writer = new PdfWriter(pdf, fonts, model.name);
  writer.header(model.name, model.headline, model.contact, model.permit);

  writer.space(4);
  writer.text(model.date, { font: fonts.regular, size: 9.5, color: MUTED, lineHeight: 13, after: 8 });
  for (const line of model.addressee) {
    writer.text(line, { font: fonts.bold, size: 9.6, color: INK, lineHeight: 12.5, after: 0 });
  }
  writer.space(6);
  writer.text(model.salutation, { size: 10.1, color: INK, lineHeight: 14, after: 8 });
  for (const paragraph of model.paragraphs) {
    writer.text(paragraph, { size: 10.3, lineHeight: 15.1, after: 10 });
  }
  writer.space(2);
  writer.text(model.closing, { size: 10.1, color: INK, lineHeight: 14, after: 3 });
  writer.text(model.name, { font: fonts.bold, size: 10.5, color: BLUE, lineHeight: 14, after: 0 });

  writer.finish(false);
  return Buffer.from(await pdf.save());
}
