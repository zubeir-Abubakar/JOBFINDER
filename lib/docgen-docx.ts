import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Packer,
  PageNumber,
  Paragraph,
  Tab,
  TabStopType,
  TextRun,
} from "docx";
import type { CoverDocModel, CvDocModel } from "./document-model";

const BLUE = "1E73B8";
const INK = "1A202C";
const MUTED = "586273";
const FONT = "Arial";
const CONTENT_TWIPS = 10080;

function run(text: string, options: { bold?: boolean; italics?: boolean; size?: number; color?: string } = {}): TextRun {
  return new TextRun({
    text,
    font: FONT,
    size: options.size ?? 20,
    bold: options.bold ?? false,
    italics: options.italics ?? false,
    color: options.color ?? INK,
  });
}

function tab(): TextRun {
  return new TextRun({ children: [new Tab()] });
}

function heading(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 190, after: 55 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, color: BLUE, space: 3 },
    },
    children: [run(text.toUpperCase(), { bold: true, size: 19, color: BLUE })],
  });
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 28 },
    children: [run(text, { size: 19 })],
  });
}

function row(left: string, right: string, leftSize = 20, rightSize = 18): Paragraph {
  return new Paragraph({
    tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_TWIPS }],
    spacing: { before: 105, after: 12 },
    children: [
      run(left, { bold: true, size: leftSize, color: BLUE }),
      tab(),
      run(right, { italics: true, size: rightSize, color: MUTED }),
    ],
  });
}

function header(name: string, headline: string, contact: string[], permit: string | null): Paragraph[] {
  const paragraphs = [
    new Paragraph({ spacing: { after: 12 }, children: [run(name.toUpperCase(), { bold: true, size: 44, color: BLUE })] }),
  ];
  if (headline) paragraphs.push(new Paragraph({ spacing: { after: 12 }, children: [run(headline, { size: 20, color: BLUE })] }));
  if (contact.length) paragraphs.push(new Paragraph({ spacing: { after: 10 }, children: [run(contact.join(" | "), { size: 17.5 })] }));
  if (permit) paragraphs.push(new Paragraph({ spacing: { after: 10 }, children: [run(permit, { size: 17, color: MUTED })] }));
  paragraphs.push(
    new Paragraph({
      spacing: { after: 150 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 9, color: BLUE, space: 4 } },
      children: [],
    }),
  );
  return paragraphs;
}

function footer(name: string): Footer {
  return new Footer({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_TWIPS }],
        children: [
          run(name.toUpperCase(), { size: 13, color: MUTED }),
          tab(),
          new TextRun({
            children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES],
            font: FONT,
            size: 13,
            color: MUTED,
          }),
        ],
      }),
    ],
  });
}

function baseSection(model: { name: string }, children: Paragraph[], withFooter = true) {
  return {
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1080, right: 1080, bottom: 1080, left: 1080, header: 432, footer: 432, gutter: 0 },
      },
    },
    footers: withFooter ? { default: footer(model.name) } : undefined,
    children,
  };
}

export async function renderCvDocx(model: CvDocModel): Promise<Buffer> {
  const children: Paragraph[] = [...header(model.name, model.headline, model.contact, model.permit)];
  children.push(heading("Professional Summary"));
  children.push(new Paragraph({ spacing: { after: 50 }, children: [run(model.summary, { size: 19.5 })] }));

  children.push(heading("Technical Skills"));
  for (const group of model.skillGroups) {
    children.push(
      new Paragraph({
        tabStops: [{ type: TabStopType.LEFT, position: 3200 }],
        spacing: { after: 25 },
        children: [run(`${group.label}:`, { bold: true, size: 18.5, color: BLUE }), tab(), run(group.values.join(", "), { size: 18.5 })],
      }),
    );
  }

  children.push(heading("Professional Experience"));
  for (const role of model.roles) {
    children.push(row(role.title, role.dates));
    children.push(
      new Paragraph({
        spacing: { after: role.note ? 0 : 30 },
        children: [run(`${role.company}${role.location ? `, ${role.location}` : ""}`, { bold: true, size: 19, color: BLUE })],
      }),
    );
    if (role.summary) {
      children.push(new Paragraph({ spacing: { after: 20 }, children: [run(role.summary, { size: 18.5 })] }));
    }
    if (role.note) {
      children.push(new Paragraph({ spacing: { after: 25 }, children: [run(role.note, { italics: true, size: 18, color: MUTED })] }));
    }
    for (const item of role.bullets) children.push(bullet(item));
    if (role.projects) {
      children.push(new Paragraph({ spacing: { after: 20 }, children: [run(`Projects: ${role.projects}`, { italics: true, size: 18, color: MUTED })] }));
    }
  }

  if (model.certifications.length) {
    children.push(heading("Certifications"));
    for (const item of model.certifications) children.push(bullet(item));
  }
  if (model.education.length) {
    children.push(heading("Education"));
    for (const item of model.education) {
      children.push(row(item.title, item.date ?? ""));
      if (item.institution) {
        children.push(new Paragraph({ spacing: { after: 35 }, children: [run(item.institution, { italics: true, size: 18, color: MUTED })] }));
      }
    }
  }
  if (model.languages) {
    children.push(heading("Languages"));
    children.push(new Paragraph({ children: [run(model.languages, { size: 19 })] }));
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: FONT, size: 20, color: INK } },
      },
    },
    sections: [baseSection(model, children)],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

export async function renderCoverDocx(model: CoverDocModel): Promise<Buffer> {
  const children: Paragraph[] = [...header(model.name, model.headline, model.contact, model.permit)];
  children.push(new Paragraph({ spacing: { after: 70 }, children: [run(model.date, { size: 18, color: MUTED })] }));
  for (const line of model.addressee) {
    children.push(new Paragraph({ spacing: { after: 12 }, children: [run(line, { bold: true, size: 18.5 })] }));
  }
  children.push(new Paragraph({ spacing: { before: 60, after: 80 }, children: [run(model.salutation, { size: 19 })] }));
  for (const paragraph of model.paragraphs) {
    children.push(new Paragraph({ spacing: { after: 120, line: 300 }, children: [run(paragraph, { size: 19.5 })] }));
  }
  children.push(new Paragraph({ spacing: { after: 30 }, children: [run(model.closing, { size: 19 })] }));
  children.push(new Paragraph({ spacing: { before: 60 }, children: [run(model.name, { bold: true, size: 20, color: BLUE })] }));

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: FONT, size: 20, color: INK } },
      },
    },
    sections: [baseSection(model, children, false)],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
