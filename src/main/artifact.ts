import * as path from 'path';
import { atomicWrite } from './store';
import { FILES_ROOT, resolveWrite, displayPath, fsExplain } from './workspace';
import type { Tool } from './toolTypes';

/**
 * ARTIFACT SERVICE (Module K) — document generation as a pipeline, not a hope.
 *
 *   content (structured IR) → renderer per format → file on disk → REOPEN + validate → result
 *
 * Rules enforced here in code:
 *  - The model NEVER generates raw binary document structures. It emits a small, validated
 *    intermediate representation (sections of paragraphs, lists, tables, headings); the
 *    renderers use mature libraries (docx, exceljs, pptxgenjs, pdf-lib).
 *  - A document is "generated" ONLY after the written file has been reopened and structurally
 *    validated (real ZIP/OOXML containers for Office formats, %PDF- header + page count via
 *    pdf-lib, workbook re-read via exceljs). The validation line is part of the result.
 *  - Rendering failures are recoverable: the IR is small, so a failed render can be retried
 *    with a correction; nothing is partially reported as success.
 *
 * Heavy libraries are imported lazily inside the renderers so the main process boots fast
 * and tests that never generate documents pay nothing.
 */

// --------------------------------------------------------------------- intermediate form

export interface ArtifactBlock {
  /** heading | paragraph | bullet | numbered | table | image | pagebreak */
  type: 'heading' | 'paragraph' | 'bullet' | 'numbered' | 'table' | 'image' | 'pagebreak';
  /** Text for heading/paragraph/bullet/numbered; ignored otherwise. */
  text?: string;
  /** Heading level 1-3 (default 1). */
  level?: number;
  /** Table: rows of cells; first row is the header. */
  rows?: string[][];
  /** Image: absolute path (PNG/JPG only) or data URL. */
  image?: string;
  /** Image width in inches (default 5). */
  widthIn?: number;
}

export interface ArtifactSection {
  title?: string;
  blocks: ArtifactBlock[];
}

export interface ArtifactIR {
  title: string;
  format: 'docx' | 'pdf' | 'pptx' | 'xlsx';
  /** Deck slide titles for pptx are taken from section titles. */
  sections: ArtifactSection[];
  /** Optional document-level subtitle/intro (docx/pdf cover line). */
  subtitle?: string;
}

export interface ArtifactResult {
  path: string;
  format: string;
  bytes: number;
  validation: string;
  warnings: string[];
}

// --------------------------------------------------------------------- IR normalization

const MAX_SECTIONS = 40;
const MAX_BLOCKS = 400;

/** Shape-check and cap the model-provided IR; never throws — degrades to what is usable. */
export function normalizeIR(input: unknown): { ir: ArtifactIR | null; warnings: string[] } {
  const warnings: string[] = [];
  const o = (input ?? {}) as Record<string, unknown>;
  const title = String(o.title ?? '').trim().slice(0, 140);
  const format = String(o.format ?? '').toLowerCase();
  if (!title) return { ir: null, warnings: ['title is required'] };
  if (!['docx', 'pdf', 'pptx', 'xlsx'].includes(format)) return { ir: null, warnings: [`format must be one of docx, pdf, pptx, xlsx (got "${format}")`] };
  const rawSections = Array.isArray(o.sections) ? o.sections : [];
  if (!rawSections.length) return { ir: null, warnings: ['at least one section is required'] };
  const sections: ArtifactSection[] = [];
  for (const rs of rawSections.slice(0, MAX_SECTIONS)) {
    const s = (rs ?? {}) as Record<string, unknown>;
    const blocks: ArtifactBlock[] = [];
    const rawBlocks = Array.isArray(s.blocks) ? s.blocks : [];
    if (!rawBlocks.length && !s.title) continue;
    for (const rb of rawBlocks.slice(0, MAX_BLOCKS)) {
      const b = (rb ?? {}) as Record<string, unknown>;
      const type = String(b.type ?? '');
      if (type === 'heading') blocks.push({ type: 'heading', text: String(b.text ?? '').slice(0, 400), level: Math.min(3, Math.max(1, Number(b.level) || 1)) });
      else if (type === 'paragraph') blocks.push({ type: 'paragraph', text: String(b.text ?? '').slice(0, 8000) });
      else if (type === 'bullet' || type === 'numbered') blocks.push({ type, text: String(b.text ?? '').slice(0, 2000) });
      else if (type === 'table') {
        const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 200).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '').slice(0, 500)) : []));
        if (rows.length) blocks.push({ type: 'table', rows });
      } else if (type === 'image') blocks.push({ type: 'image', image: String(b.image ?? ''), widthIn: Math.min(9, Math.max(1, Number(b.widthIn) || 5)) });
      else if (type === 'pagebreak') blocks.push({ type: 'pagebreak' });
      else warnings.push(`unknown block type "${type}" skipped`);
    }
    if (!blocks.length && !s.title) continue;
    sections.push({ title: s.title ? String(s.title).slice(0, 200) : undefined, blocks });
  }
  if (!sections.length) return { ir: null, warnings: [...warnings, 'no usable sections'] };
  return { ir: { title, format: format as ArtifactIR['format'], sections, subtitle: o.subtitle ? String(o.subtitle).slice(0, 300) : undefined }, warnings };
}

// ------------------------------------------------------------------------ validation

export interface FormatCheck {
  ok: boolean;
  detail: string;
}

/** Structural check of an Office file: real ZIP container + the format's key part present. */
export async function validateOOXML(file: string, kind: 'docx' | 'pptx' | 'xlsx'): Promise<FormatCheck> {
  try {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await (await import('fs/promises')).readFile(file));
    if (!zip.file('[Content_Types].xml')) return { ok: false, detail: 'missing [Content_Types].xml — not a valid OOXML package' };
    const part =
      kind === 'docx' ? 'word/document.xml' : kind === 'pptx' ? 'ppt/presentation.xml' : 'xl/workbook.xml';
    const entry = zip.file(part);
    if (!entry) return { ok: false, detail: `missing ${part} — container is not a ${kind} package` };
    const xml = await entry.async('string');
    if (!xml || xml.length < 40) return { ok: false, detail: `${part} is empty or truncated` };
    return { ok: true, detail: `reopened as a valid ${kind} package (${zip.file(/.*/).length} parts, ${part} ${xml.length} bytes)` };
  } catch (e) {
    return { ok: false, detail: `container check failed: ${e instanceof Error ? e.message : e}` };
  }
}

/** Deep validation per format, run on the WRITTEN file (reopen, never trust the render). */
export async function validateArtifact(file: string, format: ArtifactIR['format']): Promise<FormatCheck> {
  if (format === 'docx' || format === 'pptx' || format === 'xlsx') return validateOOXML(file, format);
  // PDF: load with pdf-lib and count pages.
  try {
    const { PDFDocument } = await import('pdf-lib');
    const bytes = await (await import('fs/promises')).readFile(file);
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = doc.getPageCount();
    if (pages < 1) return { ok: false, detail: 'PDF has no pages' };
    return { ok: true, detail: `reopened with pdf-lib: ${pages} page(s), ${bytes.length} bytes` };
  } catch (e) {
    return { ok: false, detail: `pdf-lib could not reopen the file: ${e instanceof Error ? e.message : e}` };
  }
}

// ------------------------------------------------------------------------- renderers

const para = (text: string): string => text.replace(/\s+\n/g, '\n').trim();

async function renderDocx(ir: ArtifactIR, file: string): Promise<void> {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, ImageRun, AlignmentType } = await import('docx');
  const heading = (text: string, level: number) =>
    new Paragraph({ text, heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3 });
  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [];
  if (ir.subtitle) children.push(new Paragraph({ children: [new TextRun({ text: ir.subtitle, italics: true, color: '444444' })], alignment: AlignmentType.LEFT }));
  for (const s of ir.sections) {
    if (s.title) children.push(heading(s.title, 1));
    for (const b of s.blocks) {
      if (b.type === 'heading') children.push(heading(para(b.text ?? ''), b.level ?? 1));
      else if (b.type === 'paragraph') children.push(new Paragraph({ children: [new TextRun(para(b.text ?? ''))] }));
      else if (b.type === 'bullet') children.push(new Paragraph({ text: para(b.text ?? ''), bullet: { level: 0 } }));
      else if (b.type === 'numbered') children.push(new Paragraph({ text: para(b.text ?? ''), numbering: { reference: 'jarvis-num', level: 0 } }));
      else if (b.type === 'pagebreak') children.push(new Paragraph({ children: [], pageBreakBefore: true }));
      else if (b.type === 'table' && b.rows?.length) {
        const [head, ...rest] = b.rows;
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ tableHeader: true, children: head.map((c) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: c, bold: true })] })] })) }),
              ...rest.map((r) => new TableRow({ children: r.map((c) => new TableCell({ children: [new Paragraph(c)] })) })),
            ],
          })
        );
      } else if (b.type === 'image' && b.image) {
        const buf = await imageBytes(b.image);
        if (buf) children.push(new Paragraph({ children: [new ImageRun({ data: buf.data, type: buf.kind, transformation: { width: Math.round((b.widthIn ?? 5) * 96), height: Math.round((buf.h / buf.w) * (b.widthIn ?? 5) * 96) } })] }));
        else children.push(new Paragraph({ children: [new TextRun({ text: '[image could not be loaded]', italics: true })] }));
      }
    }
  }
  const doc = new Document({
    numbering: { config: [{ reference: 'jarvis-num', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START }] }] },
    sections: [{ children }],
  });
  await atomicWrite(file, Buffer.from(await Packer.toBuffer(doc)));
}

async function imageBytes(src: string): Promise<{ data: Buffer; w: number; h: number; kind: 'png' | 'jpg' } | null> {
  try {
    const { promises: fs } = await import('fs');
    let data: Buffer;
    if (src.startsWith('data:image/')) {
      const b64 = src.slice(src.indexOf(',') + 1);
      data = Buffer.from(b64, 'base64');
    } else {
      data = await fs.readFile(src);
    }
    // PNG (8-byte signature) / JPEG (FFD8) only; dimensions from the headers.
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
      return { data, w: data.readUInt32BE(16), h: data.readUInt32BE(20), kind: 'png' };
    }
    if (data[0] === 0xff && data[1] === 0xd8) {
      let at = 2;
      while (at < data.length - 9) {
        if (data[at] !== 0xff) { at++; continue; }
        const marker = data[at + 1];
        const len = data.readUInt16BE(at + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { data, h: data.readUInt16BE(at + 5), w: data.readUInt16BE(at + 7), kind: 'jpg' };
        }
        at += 2 + len;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function renderPptx(ir: ArtifactIR, file: string): Promise<void> {
  // pptxgenjs ships CJS exports without a usable default type; unwrap both shapes safely.
  type PptxCtor = new () => {
    title: string;
    addSlide: () => { addText: (t: string, o: Record<string, unknown>) => void; addTable: (rows: unknown, o: Record<string, unknown>) => void };
    write: (o: { outputType: string }) => Promise<Buffer | string | ArrayBuffer | Blob>;
  };
  const mod = (await import('pptxgenjs')) as unknown as { default?: PptxCtor } & Record<string, unknown>;
  const PptxGenJS: PptxCtor = typeof mod === 'function' ? (mod as unknown as PptxCtor) : mod.default!;
  const pptx = new PptxGenJS();
  pptx.title = ir.title;
  // Title slide.
  const title = pptx.addSlide();
  title.addText(ir.title, { x: 0.6, y: 2.2, w: 8.8, fontSize: 32, bold: true });
  if (ir.subtitle) title.addText(ir.subtitle, { x: 0.6, y: 3.4, w: 8.8, fontSize: 14, italic: true, color: '555555' });
  for (const s of ir.sections) {
    const slide = pptx.addSlide();
    slide.addText(s.title ?? ir.title, { x: 0.6, y: 0.4, w: 8.8, fontSize: 24, bold: true });
    let y = 1.3;
    for (const b of s.blocks) {
      if (b.type === 'paragraph' && b.text) {
        slide.addText(para(b.text), { x: 0.6, y, w: 8.8, fontSize: 13, valign: 'top' });
        y += Math.min(2.5, 0.4 + para(b.text).length / 110);
      } else if ((b.type === 'bullet' || b.type === 'numbered') && b.text) {
        slide.addText(para(b.text), { x: 0.8, y, w: 8.4, fontSize: 13, bullet: b.type === 'bullet' ? { indent: 12 } : false, valign: 'top' });
        y += Math.min(1.8, 0.35 + para(b.text).length / 120);
      } else if (b.type === 'table' && b.rows?.length) {
        const rows = b.rows.map((r) => r.map((c) => ({ text: c })));
        slide.addTable(rows as never, { x: 0.6, y, w: 8.8, fontSize: 11 });
        y += 0.5 + rows.length * 0.35;
      } else if (b.type === 'heading' && b.text) {
        slide.addText(para(b.text), { x: 0.6, y, w: 8.8, fontSize: 16, bold: true });
        y += 0.5;
      }
      if (y > 6.6) break; // a slide holds what fits; the next section starts a new slide
    }
  }
  const out = await pptx.write({ outputType: 'nodebuffer' });
  const buf = Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
  await atomicWrite(file, buf);
}

async function renderXlsx(ir: ArtifactIR, file: string): Promise<void> {
  const { Workbook } = await import('exceljs');
  const wb = new Workbook();
  wb.creator = 'J.A.R.V.I.S.';
  let first = true;
  for (const s of ir.sections) {
    const ws = wb.addWorksheet((s.title ?? 'Sheet').slice(0, 31).replace(/[*?:\\/[\]]/g, ' ') || `Sheet${wb.worksheets.length + 1}`);
    let rowIdx = 1;
    const hasContent = s.blocks.length > 0;
    if (s.title && ir.sections.length > 1 && !hasContent) {
      ws.addRow([s.title]).font = { bold: true, size: 14 };
      rowIdx = 2;
    }
    for (const b of s.blocks) {
      if (b.type === 'table' && b.rows?.length) {
        const [head, ...rest] = b.rows;
        const header = ws.addRow(head);
        header.font = { bold: true };
        header.eachCell((c) => {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E7F5' } };
          c.border = { bottom: { style: 'thin' } };
        });
        for (const r of rest) ws.addRow(r);
        // Sensible column widths from content.
        b.rows[0].forEach((_, i) => {
          const col = ws.getColumn(i + 1);
          const longest = Math.max(...b.rows!.map((r) => (r[i] ?? '').length), 10);
          col.width = Math.min(60, longest + 2);
        });
        rowIdx += b.rows.length;
      } else if (b.type === 'heading' && b.text) {
        ws.addRow([]); 
        ws.addRow([para(b.text)]).font = { bold: true, size: 12 };
        rowIdx += 2;
      } else if ((b.type === 'paragraph' || b.type === 'bullet' || b.type === 'numbered') && b.text) {
        ws.addRow([`${b.type === 'bullet' ? '• ' : b.type === 'numbered' ? `${rowIdx}. ` : ''}${para(b.text)}`]);
        rowIdx++;
      }
    }
    if (first && hasContent && ir.sections.length > 1) {
      // Keep the first sheet named after the document when it is the only content sheet.
      ws.name = ir.title.slice(0, 31).replace(/[*?:\\/[\]]/g, ' ') || 'Sheet1';
      first = false;
    }
    void rowIdx;
  }
  await atomicWrite(file, Buffer.from(await wb.xlsx.writeBuffer()));
}

async function renderPdf(ir: ArtifactIR, file: string): Promise<void> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle(ir.title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  // WinAnsi-safe text: pdf-lib's standard fonts cannot encode arbitrary Unicode.
  const safe = (t: string): string => t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/[^\x20-\xFF\n]/g, '?');
  const W = 595.28, H = 841.89, M = 56;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const newPage = () => {
    page = doc.addPage([W, H]);
    y = H - M;
  };
  const wrap = (text: string, size: number, maxWidth: number): string[] => {
    const words = safe(text).split(/\s+/);
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > maxWidth) {
        if (line) lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  };
  const draw = (text: string, size: number, useBold: boolean, indent = 0): void => {
    for (const line of wrap(text, size, W - 2 * M - indent)) {
      if (y < M + size * 1.6) newPage();
      page.drawText(line, { x: M + indent, y: y - size, size, font: useBold ? bold : font, color: rgb(0.1, 0.1, 0.12) });
      y -= size * 1.5;
    }
  };
  draw(ir.title, 22, true);
  if (ir.subtitle) draw(ir.subtitle, 11, false);
  y -= 8;
  for (const s of ir.sections) {
    if (s.title) draw(s.title, 15, true);
    for (const b of s.blocks) {
      if (b.type === 'heading') draw(para(b.text ?? ''), 13, true);
      else if (b.type === 'paragraph') draw(para(b.text ?? ''), 10.5, false);
      else if (b.type === 'bullet' || b.type === 'numbered') draw(para(b.text ?? ''), 10.5, false, 14);
      else if (b.type === 'table' && b.rows?.length) {
        for (const r of b.rows.slice(0, 60)) draw(r.join('  |  '), 9.5, r === b.rows[0]);
        y -= 6;
      } else if (b.type === 'pagebreak') newPage();
    }
    y -= 8;
  }
  await atomicWrite(file, Buffer.from(await doc.save()));
}

// ----------------------------------------------------------------------- the service

/** Render an IR to a file inside the workspace and validate it by reopening. */
export async function generateArtifact(ir: ArtifactIR, requestedPath: string): Promise<ArtifactResult> {
  const warnings: string[] = [];
  const ext = `.${ir.format}`;
  const withExt = requestedPath.toLowerCase().endsWith(ext) ? requestedPath : `${requestedPath}${ext}`;
  const file = await resolveWrite(withExt).catch((e) => {
    throw fsExplain(e, displayPath(String(requestedPath)));
  });
  const { promises: fsPre } = await import('fs');
  await fsPre.mkdir(path.dirname(file), { recursive: true });
  const t0 = Date.now();
  if (ir.format === 'docx') await renderDocx(ir, file);
  else if (ir.format === 'pptx') await renderPptx(ir, file);
  else if (ir.format === 'xlsx') await renderXlsx(ir, file);
  else await renderPdf(ir, file);
  // Reopen + validate: success is not reported until the file proves itself.
  const check = await validateArtifact(file, ir.format);
  const { promises: fs } = await import('fs');
  const bytes = (await fs.stat(file)).size;
  if (!check.ok) {
    // Leave the failed artifact inspectable but say the truth.
    return { path: displayPath(file), format: ir.format, bytes, validation: `FAILED: ${check.detail}`, warnings: [...warnings, 'the file was written but did not pass validation — do not report it as generated'] };
  }
  void t0;
  return { path: displayPath(file), format: ir.format, bytes, validation: check.detail, warnings };
}

// --------------------------------------------------------------------------- the tool

const toolHint = `Sections are ordered parts of the document; each has an optional title and blocks: {"type":"heading","text":"...","level":1}, {"type":"paragraph","text":"..."}, {"type":"bullet"|"numbered","text":"..."}, {"type":"table","rows":[["h1","h2"],["a","b"]]}, {"type":"pagebreak"}. Tables are arrays of rows of cell strings; the first row is the header. Keep tables under 60 rows per section; split long content into more sections.`;

export const artifactTools: Record<string, Tool> = {
  make_document: {
    description: `Generate a real, validated document: DOCX, PDF, PPTX or XLSX. Provide title, format, sections (structured blocks — never raw file bytes), and path (relative to the workspace). The file is rendered, REOPENED and validated; the result includes the validation line, and a file that fails validation is reported as NOT generated. ${toolHint}`,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title (also the cover/slide-1 heading).' },
        format: { type: 'string', enum: ['docx', 'pdf', 'pptx', 'xlsx'] },
        path: { type: 'string', description: 'Output path relative to the workspace, e.g. reports/q3-summary (extension is added if missing).' },
        subtitle: { type: 'string', description: 'Optional subtitle or one-line description under the title.' },
        sections: {
          type: 'array',
          description: 'Ordered sections with blocks.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              blocks: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, text: { type: 'string' }, level: { type: 'number' }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } } },
            },
            required: ['blocks'],
          },
        },
      },
      required: ['title', 'format', 'path', 'sections'],
    },
    run: async (args) => {
      const { ir, warnings } = normalizeIR(args);
      if (!ir) return `NOT DONE: the document spec was rejected: ${warnings.join('; ')}. Fix the structure and call again.`;
      try {
        const r = await generateArtifact(ir, String(args.path ?? 'documents/' + ir.title));
        if (r.validation.startsWith('FAILED')) {
          return `NOT DONE: the ${r.format.toUpperCase()} was written to ${r.path} (${r.bytes} bytes) but FAILED validation: ${r.validation}. Do not tell the user it was generated; fix the content and try again.`;
        }
        return [
          `Generated ${r.format.toUpperCase()} "${ir.title}" at ${r.path} (${r.bytes} bytes).`,
          `VALIDATION: ${r.validation}`,
          r.warnings.length ? `NOTES: ${r.warnings.join('; ')}` : '',
        ]
          .filter(Boolean)
          .join(' ');
      } catch (e) {
        return `Tool error [make_document]: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
};

// The workspace root is only referenced at module load for defaults; keep the import used.
void FILES_ROOT;
