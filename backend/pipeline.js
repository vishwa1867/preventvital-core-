#!/usr/bin/env node
'use strict';

/**
 * PreventVital 3-stage OCR pipeline.
 *
 * Stage 1 (ocrToJson): run OCR on the file and produce a UNIVERSAL JSON of the
 *   report: every OCR line plus pre-extracted {label, value, unit, refRange}
 *   pairs. Contains no test-specific logic — works for any lab format.
 *
 * Stage 2 (mapToTemplate): match the Stage-1 pairs against the canonical test
 *   definitions in schema/Lab_Test_Schema.json. Produces mappedPairs with
 *   confidence scores and match provenance (alias used, edit score).
 *
 * Stage 3 (bridge): the mapped pairs are handed to the existing form/merge
 *   pipeline (upload.js) as if they were parsed rows — no downstream change.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'schema', 'Lab_Test_Schema.json'), 'utf8')
);
const CATALOGUE = SCHEMA['x-canonicalTests'];
const UNIT_ALIASES = SCHEMA['x-unitAliases'];
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS) || 60000;
const WINDOWS_TESSERACT = 'C:/Program Files/Tesseract-OCR/tesseract.exe';
const TESSERACT =
  process.env.TESSERACT_PATH ||
  (process.platform === 'win32' && fs.existsSync(WINDOWS_TESSERACT) ? WINDOWS_TESSERACT : 'tesseract');

// ---------------------------------------------------------------------------
// Raw OCR engines (same strategies as extract.js, isolated so the pipeline
// owns its own line format).
// ---------------------------------------------------------------------------

function ocrLines(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') {
    const txt = execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], {
      timeout: OCR_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    let page = 1;
    return txt.split('\n')
      .map((t, i) => {
        const pageNumber = page;
        page += (t.match(/\f/g) || []).length;
        return { lineNumber: i + 1, pageNumber, text: t.replace(/\f/g, '').trim() };
      })
      .filter((l) => l.text);
  }
  const tsv = execFileSync(TESSERACT, [file, 'stdout', '--psm', '6', 'tsv'], {
    timeout: OCR_TIMEOUT_MS,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const lines = new Map();
  for (const row of tsv.split('\n').slice(1)) {
    const c = row.split('\t');
    if (c.length < 12) continue;
    const [, , , parNum, lineNum] = c;
    const conf = parseFloat(c[10]);
    const text = (c[11] || '').trim();
    if (!text || conf < 0) continue;
    const key = `${parNum}:${lineNum}`;
    if (!lines.has(key)) lines.set(key, { words: [], confs: [] });
    lines.get(key).words.push(text);
    lines.get(key).confs.push(conf);
  }
  return [...lines.values()].map((l, i) => ({
    lineNumber: i + 1,
    pageNumber: 1,
    text: l.words.join(' '),
    confidence: l.confs.reduce((a, b) => a + b, 0) / l.confs.length / 100,
  }));
}

// ---------------------------------------------------------------------------
// STAGE 1 — universal JSON of the report
// ---------------------------------------------------------------------------

const PAIR_PATTERNS = [
  // "Hemoglobin  13.2  g/dL  13.0 - 17.0"
  /^(?<label>[A-Za-z][A-Za-z0-9 .,()\/%\-]{2,45}?)\s+(?<value>[<>]?\s?\d{1,5}(?:[.,]\d{1,3})?)\s+(?<unit>[A-Za-z%][A-Za-z0-9\/%.]{0,12})?\s*(?<ref>\d{1,4}(?:\.\d+)?\s*[-–]\s*\d{1,4}(?:\.\d+)?|[<>≤≥]\s*\d{1,4}(?:\.\d+)?)?\s*$/,
  // "Hemoglobin : 13.2"
  /^(?<label>[A-Za-z][A-Za-z0-9 .,()\/%\-]{2,45}?)\s*[:;]\s*(?<value>[<>]?\s?\d{1,5}(?:[.,]\d{1,3})?)\s*(?<unit>[A-Za-z%][A-Za-z0-9\/%.]{0,12})?\s*(?<ref>\d{1,4}(?:\.\d+)?\s*[-–]\s*\d{1,4}(?:\.\d+)?|[<>≤≥]\s*\d{1,4}(?:\.\d+)?)?\s*$/,
];

function parseRefText(text) {
  if (!text) return null;
  const m1 = /(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/.exec(text);
  if (m1) return { low: +m1[1], high: +m1[2] };
  const m2 = /^[<>≤≥]\s*(\d+(?:\.\d+)?)/.exec(text);
  if (m2) return /<[≤]/.test(text) ? { low: null, high: +m2[1] } : { low: +m2[1], high: null };
  return null;
}

const LABEL_STOP = /^(page|of|date|time|total amount|amount|collected|reported|printed|vial|barcode|visit|web|www|email|phone|tel|fax|reg|uhid|bill|invoice|amt|volume|\d)/i;

function stage1OcrToJson(file) {
  const lines = ocrLines(file);
  const pairs = [];
  for (const line of lines) {
    const normalised = line.text.replace(/\s+[:;|~]+(?=\s)/g, ' ').replace(/\s+/g, ' ').trim();
    for (const re of PAIR_PATTERNS) {
      const m = re.exec(normalised);
      if (m) {
        const { label, value, unit, ref } = m.groups;
        pairs.push({
          label: label.trim(),
          valueText: value.trim(),
          qualifier: /^[<>]/.test(value.trim()) ? value.trim()[0] : null,
          value: parseFloat(value.replace(/[^0-9.]/g, '').replace(',', '.')),
          unit: unit ? unit.trim() : null,
          refRange: parseRefText(ref),
          sourceLine: line.lineNumber,
          pageNumber: line.pageNumber,
          confidence: line.confidence != null ? line.confidence : null,
          rawText: line.text,
        });
        break; // first matching pattern wins for this line
      }
    }
  }
  return {
    schemaVersion: 2,
    engine: path.extname(file).toLowerCase() === '.pdf' ? 'pdftotext' : 'tesseract',
    file: path.basename(file),
    lineCount: lines.length,
    lines: lines.map((l) => ({ n: l.lineNumber, page: l.pageNumber, text: l.text, conf: l.confidence ?? null })),
    pairs,
  };
}

// ---------------------------------------------------------------------------
// STAGE 2 — template mapping against Lab_Test_Schema
// ---------------------------------------------------------------------------

function editDistance(a, b) { /* same intent as extract.js editDistance */
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i, ...Array(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

const LOOKALIKE = new Set(['i', 'l', '1', '|']);
function onlyGlyphConfusion(a, b) {
  if (a.length !== b.length) return false;
  let diffs = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (!LOOKALIKE.has(a[i]) || !LOOKALIKE.has(b[i])) return false;
    diffs++;
  }
  return diffs <= 1;
}

function normaliseUnit(raw) {
  if (!raw) return null;
  const k = raw.toLowerCase().replace(/[\s.]/g, '');
  if (UNIT_ALIASES[k]) return UNIT_ALIASES[k];
  for (const [alias, canonical] of Object.entries(UNIT_ALIASES)) {
    const a = alias.replace(/[\s.]/g, '');
    if (a === k) return canonical;
    if (a.length > 3 && onlyGlyphConfusion(k, a)) return canonical;
  }
  return null;
}

function normaliseName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A stage-1 pair can only map to one template entry. Glucose-family and other
// lookalikes are disambiguated by *required discriminator words*, mirroring the
// schema note for fasting_glucose: a bare "glucose" must NOT match.
function stage2MapPairs(pairs) {
  const ids = Object.keys(CATALOGUE).filter((k) => k !== 'description');
  const out = [];
  for (const p of pairs) {
    const probe = normaliseName(p.label);
    if (!probe || probe.length < 2) continue;

    let best = { id: null, score: 0, alias: null };
    for (const id of ids) {
      for (const alias of CATALOGUE[id].aliases) {
        const a = normaliseName(alias);
        if (!a) continue;
        // Reject matches where a discriminating alias word is missing from the
        // probe (e.g. alias "glucose fasting" needs "fasting" in the report).
        const aliasWords = a.split(' ');
        if (!aliasWords.every((w) => probe.split(' ').includes(w)) && probe.length <= a.length + 2) continue;
        const d = editDistance(probe, a);
        const score = 1 - d / Math.max(probe.length, a.length);
        if (score > best.score) best = { id, score, alias };
      }
    }

    const entry = best.id ? CATALOGUE[best.id] : null;
    const unit = normaliseUnit(p.unit);
    const mapped = {
      testId: best.id,
      testName: entry ? entry.displayName : null,
      label: p.label,
      value: p.value,
      qualifier: p.qualifier,
      unit,
      refRange: p.refRange,
      line: p.sourceLine,
      rawText: p.rawText,
      matchScore: Number(best.score.toFixed(3)),
      matchAlias: best.alias,
      unitValid: !!unit && entry ? unit === entry.canonicalUnit : unit != null,
      inRange: p.refRange ? (p.refRange.low != null && !p.refRange.high) || (p.refRange.high != null && !p.refRange.low) ? null : p.value >= p.refRange.low && p.value <= p.refRange.high : null,
      decisionLevel: best.score >= 0.82 ? 'auto' : best.score >= 0.62 ? 'review' : 'unmapped',
    };
    if (mapped.decisionLevel !== 'unmapped') out.push(mapped);
  }
  return out;
}

// ---------------------------------------------------------------------------
// STAGE 3 — bridge to the existing form/merge pipeline (upload.js). The mapped
// pairs are turned to the row shape extract.js's tests array expects, so
// upload.js can consume them with minimal change.
// ---------------------------------------------------------------------------

function stage3Bridge(mappedPairs) {
  return mappedPairs.map((mp) => ({
    canonicalId: mp.decisionLevel === 'auto' ? mp.testId : null, // review-level matches do NOT auto-fill
    displayName: mp.testName,
    value: mp.value,
    unit: mp.unit,
    qualifier: mp.qualifier,
    referenceRange: mp.refRange ? { ...mp.refRange, source: 'report' } : null,
    raw: {
      nameText: mp.label,
      valueText: String(mp.value),
      unitText: mp.unit || '',
      referenceText: '',
      flagText: null,
      pageNumber: null,
      lineNumber: mp.line,
    },
    validation: mp.decisionLevel === 'auto' ? { status: 'pass', checks: [] } : { status: 'fail', checks: [{ code: 'REVIEW_REQUIRED', severity: 'fail' }] },
    confidence: { nameMatch: mp.matchScore, valueParse: 1, overall: mp.matchScore },
    _matchAlias: mp.matchAlias,
    _rawText: mp.rawText,
  }));
}

module.exports = { stage1OcrToJson, stage2MapPairs, stage3Bridge, ocrLines };
