const fs = require('fs');
const os = require('os');
const path = require('path');
const { extract, buildMessages, buildIntake, summariseForm, FORM } = require('./extract');
const { stage1OcrToJson, stage2MapPairs, stage3Bridge } = require('./pipeline');

const LIMITS = {
  maxFiles: Number(process.env.EXTRACT_MAX_FILES) || 5,
  maxBytes: Number(process.env.EXTRACT_MAX_BYTES) || 15 * 1024 * 1024,
};

const TYPES = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/tiff': '.tif',
  'image/bmp': '.bmp',
};

const RANK = { filled: 0, check: 1, not_found: 2, ask_user: 3, not_applicable: 4 };

function extensionFor(file) {
  const mime = String(file.mimetype || '').toLowerCase();
  if (TYPES[mime]) return TYPES[mime];
  const ext = path.extname(file.originalname || '').toLowerCase();
  return Object.values(TYPES).includes(ext) || ext === '.jpeg' ? ext : null;
}

// Detect the REAL file type from magic bytes. Files received through WhatsApp
// or re-saved by some apps are frequently a JPEG image renamed to .pdf (or the
// mime type is misreported), so trust the content, not the name.
function sniffType(buffer) {
  const head = buffer.slice(0, 12);
  if (head.length >= 4 && head.slice(0, 4).toString('binary') === '%PDF') return '.pdf';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg';
  if (head.length >= 8 && head.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return '.png';
  if (head.length >= 3 && head.slice(0, 3).toString('binary') === 'II*\u0000') return '.tif';
  if (head.length >= 3 && head.slice(0, 3).toString('binary') === 'MM\u0000*') return '.tif';
  if (head.length >= 4 && head.slice(0, 4).toString('binary') === 'RIFF' && buffer.slice(8, 12).toString('binary') === 'WEBP') return '.webp';
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) return '.bmp';
  return null;
}

function checkFile(file) {
  const name = file.originalname || 'upload';
  const mime = String(file.mimetype || '').toLowerCase();
  if (/hei[cf]/.test(mime) || /\.hei[cf]$/i.test(name)) {
    return `${name}: HEIC photos cannot be read. Please upload the photo as JPEG or PNG, or a PDF of the report.`;
  }
  if (!extensionFor(file)) return `${name}: this file type is not supported. Please upload a PDF or a photo (JPEG or PNG).`;
  const size = file.size != null ? file.size : file.buffer ? file.buffer.length : 0;
  if (!size) return `${name}: the file is empty.`;
  if (size > LIMITS.maxBytes) return `${name}: the file is larger than ${Math.round(LIMITS.maxBytes / 1024 / 1024)} MB.`;
  return null;
}

function runOne(file, dir, index) {
  const buffer = file.buffer || fs.readFileSync(file.path);
  // Trust magic bytes over the declared name/mime: a JPEG renamed to .pdf must
  // be saved and processed as a JPEG so Tesseract reads it.
  const realExt = sniffType(buffer);
  const ext = realExt || extensionFor(file);
  if (!realExt) throw new Error(`the file content could not be recognised as a PDF or image (it may be corrupted by the app that sent it — try re-sharing it, or as a photo)`);
  const target = path.join(dir, `report-${index}${ext}`);
  fs.writeFileSync(target, buffer);

  // 3-stage pipeline: OCR -> universal JSON -> template mapping.
  const doc = runPipelineDoc(target, file);
  doc.source.mediaId = `upload:${file.originalname || `file-${index}`}`;
  return doc;
}

// Runs the 3-stage pipeline and shapes the result so downstream form/merge
// code keeps working. Falls back to the bundled extract() only if the pipeline
// throws (write-time bug guard).
function runPipelineDoc(target, file) {
  const s1 = stage1OcrToJson(target);
  const s2 = stage2MapPairs(s1.pairs);
  const s3 = stage3Bridge(s2);
  const tests = s3.filter((t) => t.canonicalId);

  // Header metadata from the raw OCR lines (same fields as extract.js) — the
  // line objects are compatible since pipeline.ocrLines emits text lines.
  const { parseHeader } = require('./extract');
  const meta = parseHeader(s1.lines.map((l) => ({ text: l.text, lineNumber: l.n, pageNumber: l.page })));

  const unmapped = s1.pairs.filter((p) => !s2.some((m) => m.line === p.sourceLine));
  // Reuse the existing document shape consumed by upload.js merge functions.
  const { extract } = require('./extract');
  const legacyDoc = extract(target);
  legacyDoc.tests = tests;
  legacyDoc.source.pipeline = {
    version: '3stage-1.0',
    linesSeen: s1.lineCount,
    pairsDetected: s1.pairs.length,
    mapped: s2.map((m) => ({ testId: m.testId, score: m.matchScore, level: m.decisionLevel, line: m.line })),
    unmappedLines: unmapped.map((u) => u.rawText),
    stage1: s1,
  };
  legacyDoc.source.pageCount = Math.max(1, ...s1.lines.map((l) => l.page || 1));
  return legacyDoc;
}

function collectedTime(doc) {
  const t = Date.parse(doc.report.collectedAt || '');
  return Number.isNaN(t) ? -Infinity : t;
}

function mergeMeta(docs, warnings) {
  const byDate = [...docs].sort((a, b) => collectedTime(b) - collectedTime(a));
  const pick = (key) => {
    const d = byDate.find((x) => x.report[key] != null && x.report[key] !== '');
    return d ? d.report[key] : null;
  };
  const distinct = (key) => [...new Set(docs.map((d) => d.report[key]).filter((v) => v != null && v !== ''))];
  const meta = {
    patientNameOnReport: pick('patientNameOnReport'),
    patientAgeOnReport: pick('patientAgeOnReport'),
    patientSexOnReport: pick('patientSexOnReport'),
    bloodGroup: pick('bloodGroupOnReport'),
    accessionId: pick('accessionId'),
    collectedAt: pick('collectedAt'),
    reportedAt: pick('reportedAt'),
  };
  const names = distinct('patientNameOnReport').map((n) => n.toLowerCase().replace(/[^a-z]/g, ''));
  const sexes = distinct('patientSexOnReport');
  if (sexes.length > 1 || new Set(names).size > 1) {
    warnings.push({
      level: 'warning',
      code: 'REPORTS_DIFFERENT_PEOPLE',
      field: null,
      text: 'These reports seem to belong to different people (the name or sex printed on them differs). We have not filled your age or sex. Please upload only your own reports, or one family member at a time.',
    });
    meta.patientSexOnReport = null;
    meta.patientAgeOnReport = null;
    meta.patientNameOnReport = null;
  }
  return meta;
}

function mergeForms(docs, meta) {
  const ordered = [...docs].sort((a, b) => collectedTime(b) - collectedTime(a));
  const known = {};
  const fields = FORM.fields.map((def) => {
    const candidates = ordered.map((d) => ({ doc: d, f: d.form.steps.flatMap((s) => s.fields).find((x) => x.key === def.key) }));
    const filled = candidates.filter((c) => c.f.status === 'filled');
    let chosen = candidates.slice().sort((a, b) => RANK[a.f.status] - RANK[b.f.status])[0];
    if (filled.length) {
      const newest = collectedTime(filled[0].doc);
      const sameDay = filled.filter((c) => collectedTime(c.doc) === newest);
      const values = [...new Set(sameDay.map((c) => c.f.value))];
      chosen = filled[0];
      if (values.length > 1) {
        chosen = {
          doc: filled[0].doc,
          f: {
            ...filled[0].f,
            status: 'check',
            value: null,
            message: `Your reports from the same day show different values for ${def.label} (${values.join(' and ')}). Please check and enter the right one.`,
          },
        };
      }
    }
    const field = { ...chosen.f };
    if (field.source) field.source = { ...field.source, file: chosen.doc.source.mediaId.replace(/^upload:/, '') };
    const hint = candidates.map((c) => c.f.hint).find(Boolean);
    if (hint) field.hint = hint;
    if ((def.key === 'age' || def.key === 'sex') && meta[def.source.header] == null && field.status === 'filled') {
      field.status = 'ask_user';
      field.value = null;
      field.source = null;
      field.message = def.question;
    }
    if (field.status === 'filled') known[def.key] = field.value;
    return field;
  });
  for (const f of fields) {
    const def = FORM.fields.find((x) => x.key === f.key);
    if (!def.showIf) continue;
    const [dep, want] = Object.entries(def.showIf)[0];
    if (known[dep] !== undefined && known[dep] !== want) {
      Object.assign(f, { status: 'not_applicable', value: null, source: null, message: null });
      delete f.conditional;
    } else if (f.status === 'not_applicable') {
      Object.assign(f, { status: 'ask_user', message: def.question });
    }
  }
  return { steps: FORM.steps.map((s) => ({ step: s.step, title: s.title, fields: fields.filter((f) => f.step === s.step) })) };
}

function latestTests(docs) {
  const ordered = [...docs].sort((a, b) => collectedTime(b) - collectedTime(a));
  return ordered.flatMap((d) => d.tests);
}

function newestVitals(docs) {
  const out = {};
  for (const d of [...docs].sort((a, b) => collectedTime(b) - collectedTime(a))) {
    const v = d.intake && d.intake.vitalsOnReport;
    if (!v) continue;
    for (const [k, val] of Object.entries(v)) if (out[k] === undefined) out[k] = typeof val === 'object' ? val : { value: val };
  }
  return out;
}

function toFormResponse(docs, errors, opts = {}) {
  const warnings = [];
  const meta = mergeMeta(docs, warnings);
  const form = mergeForms(docs, meta);
  const tests = latestTests(docs);
  const fields = form.steps.flatMap((s) => s.fields);
  const formValues = {};
  const fieldState = {};
  for (const f of fields) {
    if (f.status === 'filled') formValues[f.key] = f.value;
    fieldState[f.key] = { status: f.status, value: f.value, message: f.message, source: f.source || null, ...(f.hint ? { hint: f.hint } : {}) };
  }
  const firstOpen = form.steps.find((s) => s.fields.some((f) => f.required && f.status !== 'filled' && f.status !== 'not_applicable'));
  const messages = [
    ...errors.map((text) => ({ level: 'action', code: 'FILE_NOT_READ', field: null, text })),
    ...warnings,
    ...buildMessages(form, meta, tests),
  ];
  const res = {
    ok: docs.length > 0,
    reports: docs.map((d) => ({
      file: d.source.mediaId.replace(/^upload:/, ''),
      pages: d.source.pageCount,
      collectedAt: d.report.collectedAt,
      patient: { name: d.report.patientNameOnReport, age: d.report.patientAgeOnReport, sex: d.report.patientSexOnReport },
      testsFound: d.tests.length,
    })),
    summary: summariseForm(form),
    messages,
    formValues,
    fieldState,
    firstStep: firstOpen ? firstOpen.step : null,
    intake: buildIntake(form, meta, tests, newestVitals(docs)),
  };
  if (opts.full) res.documents = docs;
  return res;
}

function extractFromUploads(files, opts = {}) {
  const list = Array.isArray(files) ? files : files ? [files] : [];
  if (!list.length) {
    return { ok: false, reports: [], summary: null, messages: [{ level: 'action', code: 'NO_FILE', field: null, text: 'Please upload a lab report: a PDF, or a clear photo of each page.' }], formValues: {}, fieldState: {}, firstStep: 1, intake: null };
  }
  const errors = [];
  if (list.length > LIMITS.maxFiles) errors.push(`Only the first ${LIMITS.maxFiles} files were read.`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-report-'));
  const docs = [];
  try {
    list.slice(0, LIMITS.maxFiles).forEach((file, i) => {
      const problem = checkFile(file);
      if (problem) return errors.push(problem);
      try {
        docs.push(runOne(file, dir, i));
      } catch (e) {
        errors.push(`${file.originalname || 'upload'}: ${e.message}`);
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!docs.length) {
    return { ok: false, reports: [], summary: null, messages: errors.map((text) => ({ level: 'action', code: 'FILE_NOT_READ', field: null, text })), formValues: {}, fieldState: {}, firstStep: 1, intake: null };
  }
  return toFormResponse(docs, errors, opts);
}

module.exports = { extractFromUploads, toFormResponse, LIMITS };
