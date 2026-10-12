#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'schema', 'Lab_Test_Schema.json'), 'utf8')
);
const CATALOGUE = SCHEMA['x-canonicalTests'];
const UNIT_ALIASES = SCHEMA['x-unitAliases'];
const POLICY = SCHEMA['x-validationPolicy'];
const PIPELINE_VERSION = '0.1.0-poc';

const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS) || 60000;
const WINDOWS_TESSERACT = 'C:/Program Files/Tesseract-OCR/tesseract.exe';
const TESSERACT =
  process.env.TESSERACT_PATH ||
  (process.platform === 'win32' && fs.existsSync(WINDOWS_TESSERACT) ? WINDOWS_TESSERACT : 'tesseract');

function ocrTesseract(file) {

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
    text: l.words.join(' '),
    confidence: l.confs.reduce((a, b) => a + b, 0) / l.confs.length / 100,
  }));
}

function ocrPdftotext(file) {

  const txt = execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], {
    timeout: OCR_TIMEOUT_MS,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  let page = 1;
  return txt
    .split('\n')
    .map((t, i) => {
      const pageNumber = page;
      page += (t.match(/\f/g) || []).length;
      return { lineNumber: i + 1, pageNumber, text: t.replace(/\f/g, '').trim(), confidence: 1.0 };
    })
    .filter((l) => l.text);
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function parseReportDate(s) {
  const m = /(\d{1,2})[\/\-.]([A-Za-z]{3}|\d{1,2})[\/\-.](\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i.exec(s || '');
  if (!m) return null;
  const month = /\d/.test(m[2]) ? Number(m[2]) : MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  let hour = m[4] ? Number(m[4]) : 0;
  if (m[6] && /pm/i.test(m[6]) && hour < 12) hour += 12;
  if (m[6] && /am/i.test(m[6]) && hour === 12) hour = 0;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${m[3]}-${p2(month)}-${p2(Number(m[1]))}T${p2(hour)}:${p2(m[5] ? Number(m[5]) : 0)}:00+05:30`;
}

function bloodGroup(text) {
  const m = /Blood\s*Group[^:\n]*[:\-]\s*(AB|A|B|O)\s*(?:Rh\s*)?(\+ve|-ve|\+|-|positive|negative|pos|neg)/i.exec(text);
  if (!m) return null;
  const sign = /^(\+ve|\+|positive|pos)$/i.test(m[2]) ? '+' : '-';
  return `${m[1].toUpperCase()}${sign}`;
}

function parseHeader(lines) {
  const text = lines.map((l) => l.text).join('\n');
  const grab = (re) => {
    const m = re.exec(text);
    return m ? m[1].trim() : null;
  };
  const name = grab(/(?:Customer|Patient)\s*Name\s*:\s*(?:(?:Mrs|Miss|Master|Mr|Ms|Dr)\b\.?\s*)?([A-Za-z][A-Za-z .']*?)(?=\s+(?:Lab|Age|Sex|Gender|Referred|Ref|Collected|Collection|Sample|Report|Patient ID|UHID|Reg|Barcode|Visit)\b|\s{2,}|\n|$)/i);
  const ageSex =
    /Age\s*\/\s*(?:Gender|Sex)\s*:\s*(\d{1,3})\s*Y[^\n\/]*\/\s*(Male|Female)/i.exec(text) ||
    /(Male|Female)\s*\/\s*(\d{1,3})\s*Y(?:rs|ears)?\b/i.exec(text);
  let age = null;
  let sex = null;
  if (ageSex) {
    const [a, b] = /\d/.test(ageSex[1]) ? [ageSex[1], ageSex[2]] : [ageSex[2], ageSex[1]];
    age = Number(a);
    sex = b.toLowerCase();
  }
  return {
    labName: null,
    labAccreditation: null,
    accessionId: grab(/(?:Lab Visit ID|Accession(?: No)?|Lab No|Sample ID)\s*:\s*(\S+)/i),
    referringDoctor: null,
    patientNameOnReport: name,
    patientAgeOnReport: age,
    patientSexOnReport: sex,
    bloodGroup: bloodGroup(text),
    collectedAt: parseReportDate(grab(/(?:Collection Date|Date of Collection|Sample Collected(?: On| At)?|Collected(?: On| At| Date)?)\s*:\s*([^\n]+?)(?:\s{2,}|\n|$)/i)),
    reportedAt: parseReportDate(grab(/(?:Report(?:ed)?(?: On| At| Date)|Date of Report)\s*:\s*([^\n]+?)(?:\s{2,}|\n|$)/i)),
  };
}

const NOISE = /^(department|test\b|result\b|lipid profile|glyc|haemat|hemat|verified|patient|age|referred|lab no|collected|reported|\*|sunrise|12 ?mg)/i;

const ROW = new RegExp(
  '^(?<name>[A-Za-z][A-Za-z0-9 .,()/%\\-]{2,45}?)\\s+' +
    '(?<value>[<>]?\\s?\\d{1,5}(?:[.,]\\d{1,3})?)\\s+' +
    '(?<rest>.*)$'
);

const NAME_ONLY = /^[A-Za-z][A-Za-z .,()\/%\-]{1,45}$/;

function parseRows(lines) {
  const rows = [];
  let prev = null;
  for (const line of lines) {
    const last = prev;
    prev = NAME_ONLY.test(line.text) ? line : null;
    if (!line.text || NOISE.test(line.text)) continue;

    const text = line.text.replace(/\s+[:;|~]+(?=\s)/g, ' ');
    const m = ROW.exec(text);
    if (!m) continue;

    let { name, value, rest } = m.groups;

    if (last && line.lineNumber - last.lineNumber <= 2 && (last.pageNumber || 1) === (line.pageNumber || 1)) {
      if (/^[a-z]{4,}/.test(name) && /[a-z]$/.test(last.text)) name = last.text + name;
      else if (/^\(/.test(name)) name = `${last.text} ${name}`;
    }
    const tokens = rest.trim().split(/\s+/);

    let flagText = null;
    if (tokens.length && /^[HL*]$/i.test(tokens[tokens.length - 1])) {
      flagText = tokens.pop().toUpperCase();
    }

    const unitText = tokens.shift() || null;
    const referenceText = tokens.join(' ') || null;

    rows.push({
      nameText: name.trim(),
      valueText: value.replace(/\s+/g, ''),
      unitText,
      referenceText,
      flagText,
      lineNumber: line.lineNumber,
      pageNumber: line.pageNumber || 1,
      ocrConfidence: line.confidence,
    });
  }
  markColumnShift(rows);
  return rows;
}

const SECTION_HEADING = /\b(test|tests|profile|panel|function|health|studies|markers|screening)\b\.?/i;

const MONTH_TOKEN = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*$/i;

function markColumnShift(rows) {
  let block = 0;
  for (const r of rows) r.blockId = block++;
  for (let i = 0; i < rows.length; i++) {
    const h = rows[i];
    if (!h.unitText || !(SECTION_HEADING.test(h.nameText) || MONTH_TOKEN.test(h.unitText))) continue;
    const members = [];
    for (let j = i + 1; j < rows.length; j++) {
      const r = rows[j];
      if (r.pageNumber !== h.pageNumber || r.lineNumber - rows[j - 1].lineNumber > 2) break;
      members.push(r);
    }
    h.columnShift = true;
    h.blockId = block;
    const summary = MONTH_TOKEN.test(h.unitText);
    if (summary) {
      for (const r of members) {
        r.referenceText = null;
        r.layoutDoubt = 'summary';
        r.blockId = block;
      }
    } else {
      const carried = [h, ...members].map((r) => ({ valueText: r.valueText, unitText: r.unitText, referenceText: r.referenceText, flagText: r.flagText }));
      members.forEach((r, k) => {
        Object.assign(r, carried[k]);
        r.layoutDoubt = 'realigned';
        r.blockId = block;
      });
    }
    block++;
    i += members.length;
  }
}

const NUM_ONLY = /^[<>]?\s?\d+(?:[.,]\d+)?$/;
const RANGE_LINE = /^[\s\d.,:<>=\-–]+$|^\s*(?:[<>]=?\s*)?\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?(?:\s+\S+)*$/;

function unitTokens(line) {
  const toks = line.split(/\s+/).filter(Boolean);
  if (!toks.length || !toks.every((t) => normaliseUnit(t))) return null;
  return toks;
}

function numberTokens(line) {
  const toks = line.replace(/([<>])\s+(?=\d)/g, '$1').split(/\s+/).filter(Boolean);
  return toks.length && toks.every((t) => NUM_ONLY.test(t)) ? toks : null;
}

function unitFits(id, unitText) {
  const u = normaliseUnit(unitText);
  return !!(id && u && CATALOGUE[id].validUnits.includes(u));
}

function segmentNames(line, units) {
  const words = line.split(/\s+/).filter(Boolean);
  const k = units.length;
  let best = null;
  for (let p = 0; p <= Math.min(6, words.length - k); p++) {
    const n = words.length - p;
    const dp = Array.from({ length: n + 1 }, () => Array(k + 1).fill(null));
    dp[0][0] = { score: -p / 2, cuts: [] };
    for (let i = 0; i < n; i++) {
      for (let s = 0; s < k; s++) {
        if (!dp[i][s]) continue;
        for (let len = 1; len <= 8 && i + len <= n; len++) {
          const seg = words.slice(p + i, p + i + len).join(' ');
          const r = resolveName(seg);
          let sc = 0;
          if (/^[(\[]/.test(seg)) sc = -100;
          else if (r.canonicalId && r.confident) sc = unitFits(r.canonicalId, units[s]) ? 3 : -100;
          else if (r.canonicalId) sc = -1;
          const cand = { score: dp[i][s].score + sc, cuts: [...dp[i][s].cuts, { seg, id: r.canonicalId && r.confident && sc > 0 ? r.canonicalId : null }] };
          if (!dp[i + len][s + 1] || cand.score > dp[i + len][s + 1].score) dp[i + len][s + 1] = cand;
        }
      }
    }
    const end = dp[n][k];
    if (end && (!best || end.score > best.score)) best = end;
  }
  if (!best || best.score <= 0) return null;
  const ids = best.cuts.map((c) => c.id).filter(Boolean);
  return new Set(ids).size === ids.length ? best.cuts : null;
}

function readTextOrder(file) {
  let txt;
  try {
    txt = execFileSync('pdftotext', ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: OCR_TIMEOUT_MS });
  } catch (e) {
    return [];
  }
  return parseTextOrder(txt);
}

function parseTextOrder(txt) {
  const rows = [];
  txt.split('\f').forEach((pageText, pi) => {
    const lines = pageText.split('\n').map((l) => l.trim()).filter(Boolean);
    const pageNumber = pi + 1;
    let i = 0;
    while (i < lines.length) {
      const nums = i + 1 < lines.length ? numberTokens(lines[i + 1]) : null;
      const units = i + 2 < lines.length ? unitTokens(lines[i + 2]) : null;
      if (/[A-Za-z]/.test(lines[i]) && nums && nums.length >= 2 && units && units.length === nums.length) {
        const cuts = segmentNames(lines[i], units);
        if (cuts) {
          cuts.forEach((c, s) => {
            if (c.id) rows.push({ nameText: c.seg, valueText: nums[s], unitText: units[s], referenceText: null, flagText: null, pageNumber, lineNumber: 100000 + pi * 1000 + i, textOrder: true, strong: true });
          });
        }
        i += 3;
        continue;
      }
      if (lines[i] === 'Method' && i + 3 < lines.length && NUM_ONLY.test(lines[i + 1]) && RANGE_LINE.test(lines[i + 3])) {
        const unit = unitTokens(lines[i + 2]);
        const k = unit && unit.length === 1 ? [...Array(Math.min(12, i)).keys()].map((d) => i - 1 - d).find((x) => resolveName(lines[x]).confident) : undefined;
        if (k !== undefined) {
          const id = resolveName(lines[k]).canonicalId;
          rows.push({ nameText: lines[k], valueText: lines[i + 1], unitText: unit[0], referenceText: lines[i + 3], flagText: null, pageNumber, lineNumber: 100000 + pi * 1000 + k, textOrder: true, strong: unitFits(id, unit[0]) });
          i += 4;
          continue;
        }
      }
      const pairs = [];
      let j = i;
      while (j + 1 < lines.length) {
        if (/[A-Za-z]/.test(lines[j]) && !unitTokens(lines[j]) && NUM_ONLY.test(lines[j + 1].replace(/^([<>])\s+/, '$1'))) {
          pairs.push({ name: lines[j], value: lines[j + 1].replace(/\s+/g, ''), at: j });
          j += 2;
        } else if (pairs.length && /[A-Za-z]/.test(lines[j]) && !unitTokens(lines[j]) && j + 2 < lines.length && NUM_ONLY.test(lines[j + 2])) {
          j += 1;
        } else break;
      }
      if (pairs.length >= 2) {
        const collected = [];
        let m = j;
        while (m < lines.length) {
          const u = unitTokens(lines[m]);
          if (u) collected.push(...u);
          else if (!RANGE_LINE.test(lines[m])) break;
          m++;
        }
        const unitsMatch = collected.length === pairs.length;
        pairs.forEach((p, s) => {
          const r = resolveName(p.name);
          if (!r.canonicalId || !r.confident) return;
          const unitText = unitsMatch ? collected[s] : null;
          const strong = unitsMatch && unitFits(r.canonicalId, unitText);
          rows.push({ nameText: p.name, valueText: p.value, unitText, referenceText: null, flagText: null, pageNumber, lineNumber: 100000 + pi * 1000 + p.at, textOrder: true, strong });
        });
        i = Math.max(m, j);
        continue;
      }
      i++;
    }
  });
  return rows;
}

function normaliseName(s) {
  return s
    .toLowerCase()
    .replace(/[.,()\[\]:]/g, ' ')
    .replace(/\b(s|b|p|serum|plasma|blood|calc|calculated|total)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function editDistance(a, b) {
  const prev = Array(b.length + 1)
    .fill(0)
    .map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}

const CANONICAL_IDS = Object.keys(CATALOGUE).filter((k) => k !== 'description');

const DISCRIMINATORS = new Set(['non', 'vldl', 'b12', 'b9', 'b6', 'ratio', 'free', 'absolute', 'nitrogen', 'direct', 'indirect', 'urine', 'random', 'pp', 'postprandial', 'prandial', 'unsaturated']);

function resolveName(rawName) {
  const probe = normaliseName(rawName);
  if (!probe) return { canonicalId: null, score: 0 };

  const markers = probe.split(' ').filter((w) => DISCRIMINATORS.has(w));

  let best = { canonicalId: null, score: 0, alias: null };
  for (const id of CANONICAL_IDS) {
    for (const alias of CATALOGUE[id].aliases) {
      const a = normaliseName(alias);
      if (!a) continue;
      if (markers.some((w) => !a.split(' ').includes(w))) continue;
      const d = editDistance(probe, a);
      const score = 1 - d / Math.max(probe.length, a.length);
      if (score > best.score) best = { canonicalId: id, score, alias };
    }
  }

  const GLUCOSE_QUALIFIER = { fasting_glucose: /fast|fbs|fpg/, pp_glucose: /pp|prandial|ppbs/, random_glucose: /random|rbs/ };
  if (GLUCOSE_QUALIFIER[best.canonicalId] && !GLUCOSE_QUALIFIER[best.canonicalId].test(probe)) {
    return { canonicalId: null, score: best.score, ambiguous: true };
  }

  if (best.score >= 0.82) return { ...best, confident: true };
  if (best.score >= 0.62) return { ...best, ambiguous: true };
  return { canonicalId: null, score: best.score };
}

function normaliseUnit(raw) {
  if (!raw) return null;
  const k = raw.toLowerCase().replace(/[\s]/g, '').replace(/\.$/, '');
  if (UNIT_ALIASES[k]) return UNIT_ALIASES[k];
  for (const [alias, canonical] of Object.entries(UNIT_ALIASES)) {
    const a = alias.replace(/\s/g, '');
    if (a === k) return canonical;
    if (a.length > 3 && onlyGlyphConfusion(k, a)) return canonical;
  }
  return null;
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

function parseValue(raw) {
  if (!raw) return { value: null, qualifier: null };
  const m = /^([<>]=?)?\s*(\d+(?:[.,]\d+)?)$/.exec(raw.trim());
  if (!m) return { value: null, qualifier: null };
  return { value: parseFloat(m[2].replace(',', '.')), qualifier: m[1] || null };
}

function parseReference(text) {
  if (!text) return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  let m = /(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/.exec(clean);
  if (m) return { low: +m[1], high: +m[2], text: clean, source: 'report' };
  m = /^[<≤]\s*(\d+(?:\.\d+)?)/.exec(clean);
  if (m) return { low: null, high: +m[1], text: clean, source: 'report' };
  m = /^[>≥]\s*(\d+(?:\.\d+)?)/.exec(clean);
  if (m) return { low: +m[1], high: null, text: clean, source: 'report' };
  return { low: null, high: null, text: clean, source: 'report' };
}

function convert(entry, value, unit) {
  if (value === null || !unit) return { value, unit, conversion: null };
  if (unit === entry.canonicalUnit) return { value, unit, conversion: null };
  const c = entry.conversions && entry.conversions[unit];
  if (!c) return { value, unit, conversion: null };
  if (c.method === 'factor') {
    return {
      value: Math.round(value * c.factor * 1000) / 1000,
      unit: entry.canonicalUnit,
      conversion: { from: unit, to: entry.canonicalUnit, method: 'factor', factor: c.factor },
    };
  }
  if (c.method === 'formula' && entry.displayName === 'HbA1c') {
    return {
      value: Math.round((0.09148 * value + 2.152) * 100) / 100,
      unit: entry.canonicalUnit,
      conversion: { from: unit, to: entry.canonicalUnit, method: 'formula', formula: c.formula },
    };
  }
  return { value, unit, conversion: null };
}

function severityOf(code) {
  if (POLICY.fail.includes(code)) return 'fail';
  if (POLICY.warn.includes(code)) return 'warn';
  return 'info';
}

function check(code, message, detail) {
  return { code, severity: severityOf(code), message: message || null, detail: detail || null };
}

const OCR_CONFIDENCE_FLOOR = 0.75;

function validateTest(t, entry, seen) {
  const checks = [];

  if (t.confidence.ocr < OCR_CONFIDENCE_FLOOR) {
    checks.push(check('OCR_LOW_CONFIDENCE', `line confidence ${t.confidence.ocr.toFixed(2)}`));
  }
  if (!t.canonicalId) {
    checks.push(check(t._ambiguous ? 'NAME_AMBIGUOUS' : 'NAME_UNRESOLVED', `"${t.raw.nameText}"`));
  } else if (t._ambiguous) {
    checks.push(check('NAME_AMBIGUOUS', `matched ${t.canonicalId} at ${t._score.toFixed(2)}`));
  }
  if (t.value === null) {
    checks.push(check('VALUE_UNPARSEABLE', `"${t.raw.valueText}"`));
  }

  if (entry) {
    if (!t.unit) {
      checks.push(check(t.raw.unitText ? 'UNIT_UNRECOGNISED' : 'UNIT_MISSING', `"${t.raw.unitText}"`));
    } else if (!entry.validUnits.includes(t.unit)) {
      checks.push(check('UNIT_NOT_VALID_FOR_TEST', `${t.unit} not valid for ${t.canonicalId}`));
    }

    if (t.value !== null) {
      const b = entry.plausibilityBounds;
      if (t.value < b.low || t.value > b.high) {
        checks.push(
          check('VALUE_IMPLAUSIBLE', `${t.value} ${t.unit || ''} outside ${b.low}-${b.high}`, b)
        );
      }
    }
  }

  let rangeTrusted = !!t.referenceRange;
  if (entry && t.referenceRange) {
    const b = entry.plausibilityBounds;
    const ends = [t.referenceRange.low, t.referenceRange.high].filter((v) => v !== null);
    if (ends.some((v) => v < b.low || v > b.high)) {
      rangeTrusted = false;
      checks.push(
        check(
          'REFERENCE_RANGE_UNPARSEABLE',
          `range ${t.referenceRange.text} is outside the plausible span for ${t.canonicalId}`
        )
      );
    }
  }

  if (t.value !== null && rangeTrusted && t.raw.flagText) {
    const { low, high } = t.referenceRange;
    const isHigh = high !== null && t.value > high;
    const isLow = low !== null && t.value < low;
    const claimed = t.raw.flagText.toUpperCase();
    if ((claimed === 'H' && !isHigh) || (claimed === 'L' && !isLow)) {
      checks.push(
        check(
          'FLAG_CONTRADICTS_VALUE',
          `report flags ${claimed} but ${t.value} sits inside ${low ?? '-'}..${high ?? '-'}`
        )
      );
    }
  }

  if (t.value !== null && rangeTrusted && !t.raw.flagText) {
    const { low, high } = t.referenceRange;
    if ((high !== null && t.value > high * 3) || (low !== null && t.value < low / 3)) {
      checks.push(check('VALUE_ORDER_OF_MAGNITUDE_SUSPECT', `${t.value} vs range ${low ?? '-'}..${high ?? '-'}`));
    }
  }

  if (!t.referenceRange) checks.push(check('REFERENCE_RANGE_MISSING'));
  if (!t.specimenCollectedAt) checks.push(check('DATE_MISSING'));

  if (t.canonicalId) {
    if (seen.has(t.canonicalId)) {
      const prior = seen.get(t.canonicalId);
      checks.push(
        check(prior.value !== t.value ? 'DUPLICATE_CONFLICTING' : 'DUPLICATE_TEST', `also on line ${prior.line}`)
      );
    } else {
      seen.set(t.canonicalId, { value: t.value, line: t.raw.lineNumber });
    }
  }

  return { status: statusOf(checks), checks };
}

function statusOf(checks) {
  return checks.some((c) => c.severity === 'fail')
    ? 'fail'
    : checks.some((c) => c.severity === 'warn')
    ? 'warn'
    : 'pass';
}

function extract(file, opts = {}) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`File not found: ${file}`);
  const kind = path.extname(file).toLowerCase();
  if (!['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'].includes(kind)) throw new Error(`Unsupported file type ${kind || '(none)'}: upload a PDF or a photo (PNG or JPEG)`);
  const started = Date.now();
  const ext = path.extname(file).toLowerCase();
  const engine = opts.engine || (ext === '.pdf' ? 'pdftotext' : 'tesseract');

  let lines;
  try {
    lines = engine === 'pdftotext' ? ocrPdftotext(file) : ocrTesseract(file);
  } catch (e) {
    const why = String((e.stderr && e.stderr.toString()) || e.message).split(/\r?\n/)[0].trim();
    if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') throw new Error('Reading the file took too long. Try a clearer photo or a smaller PDF.');
    if (e.code === 'ENOENT') throw new Error(engine === 'pdftotext' ? 'pdftotext (Poppler) is not installed, so the PDF could not be read' : 'Tesseract OCR is not installed, or TESSERACT_PATH is wrong');
    throw new Error(`Could not read the file with ${engine}: ${why}`);
  }
  const rows = parseRows(lines);
  if (engine === 'pdftotext') {
    let block = 1e6;
    for (const r of readTextOrder(file)) {
      r.blockId = block++;
      r.ocrConfidence = 1;
      rows.push(r);
    }
  }
  const pageCount = Math.max(1, ...lines.map((l) => l.pageNumber || 1));

  const meta = opts.reportMeta || parseHeader(lines);
  const seen = new Map();

  const tests = rows.map((r) => {
    const resolved = resolveName(r.nameText);
    const entry = resolved.canonicalId ? CATALOGUE[resolved.canonicalId] : null;
    const { value: rawValue, qualifier } = parseValue(r.valueText);
    const unit = normaliseUnit(r.unitText);
    const converted = entry ? convert(entry, rawValue, unit) : { value: rawValue, unit, conversion: null };

    const t = {
      raw: {
        nameText: r.nameText,
        valueText: r.valueText,
        unitText: r.unitText,
        referenceText: r.referenceText,
        flagText: r.flagText,
        methodText: r.textOrder ? 'text order' : null,
        pageNumber: r.pageNumber,
        lineNumber: r.lineNumber,
        boundingBox: null,
      },
      canonicalId: resolved.canonicalId,
      displayName: entry ? entry.displayName : null,
      loinc: null,
      value: converted.value,
      unit: converted.unit,
      valueAsReported: converted.conversion ? { value: rawValue, unit } : null,
      conversion: converted.conversion,
      qualifier,
      referenceRange: parseReference(r.referenceText),
      abnormalFlag: null,
      abnormalFlagSource: r.flagText ? 'report' : 'none',
      specimenCollectedAt: meta.collectedAt || null,
      confidence: {
        ocr: r.ocrConfidence,
        nameMatch: resolved.score || 0,
        valueParse: rawValue === null ? 0 : 1,
        overall: 0,
      },
      engineField: entry ? entry.engineField : null,
      usedByEngine: false,
      _ambiguous: !!resolved.ambiguous,
      _score: resolved.score || 0,
    };

    t.abnormalFlag = { H: 'high', L: 'low', '*': 'unknown' }[r.flagText] || null;
    t.confidence.overall =
      Math.round(
        Math.min(t.confidence.ocr, t.confidence.nameMatch || 0, t.confidence.valueParse) * 1000
      ) / 1000;

    t.validation = validateTest(t, entry, r.columnShift || r.layoutDoubt || r.textOrder ? new Map() : seen);
    if (r.columnShift) {
      t.validation.checks.push(check('COLUMN_MISALIGNED', 'value and name columns are offset in this block'));
      t.validation.status = statusOf(t.validation.checks);
    } else if (r.layoutDoubt || (r.textOrder && !r.strong)) {
      t.validation.checks.push(check('LAYOUT_UNCERTAIN', r.layoutDoubt || 'text order'));
      t.validation.status = statusOf(t.validation.checks);
    }
    delete t._ambiguous;
    delete t._score;
    return t;
  });

  const UNIT_DOUBT = new Set(['UNIT_MISSING', 'UNIT_UNRECOGNISED', 'UNIT_NOT_VALID_FOR_TEST']);
  const DOUBT = new Set(['LAYOUT_UNCERTAIN', ...UNIT_DOUBT]);
  const soundApartFromDoubt = (t) =>
    !t.validation.checks.some((c) => (c.severity === 'fail' || c.severity === 'warn') && !DOUBT.has(c.code) && c.code !== 'DUPLICATE_TEST' && c.code !== 'DUPLICATE_CONFLICTING');
  const doubtful = (t) => t.validation.checks.some((c) => DOUBT.has(c.code));
  const unitOk = (t) => t.canonicalId && t.unit === CATALOGUE[t.canonicalId].canonicalUnit;
  tests.forEach((t, i) => {
    if (!t.canonicalId || rows[i].columnShift || !doubtful(t) || !soundApartFromDoubt(t)) return;
    const second = tests.find((o, j) =>
      j !== i && o.canonicalId === t.canonicalId && rows[j].blockId !== rows[i].blockId && !rows[j].columnShift &&
      o.value === t.value && o.qualifier === t.qualifier && soundApartFromDoubt(o) && (unitOk(o) || unitOk(t)));
    if (!second) return;
    for (const x of [t, second]) {
      if (!unitOk(x)) {
        x.unit = CATALOGUE[x.canonicalId].canonicalUnit;
        x.valueAsReported = null;
      }
      const checks = x.validation.checks.filter((c) => !DOUBT.has(c.code) && c.code !== 'CONFIRMED_BY_SECOND_READING');
      checks.push(check('CONFIRMED_BY_SECOND_READING', `the same value is printed again on page ${(x === t ? second : t).raw.pageNumber}`));
      x.validation = { status: statusOf(checks), checks };
    }
  });

  const isDup = (c) => c.code === 'DUPLICATE_TEST' || c.code === 'DUPLICATE_CONFLICTING';
  const trusted = (t, i) =>
    t.canonicalId && !rows[i].columnShift && !t.validation.checks.some((c) => (c.severity === 'fail' && !isDup(c)) || DOUBT.has(c.code));
  const groups = new Map();
  tests.forEach((t, i) => {
    if (!trusted(t, i)) return;
    if (!groups.has(t.canonicalId)) groups.set(t.canonicalId, []);
    groups.get(t.canonicalId).push(t);
  });
  for (const group of groups.values()) {
    const values = [...new Set(group.map((t) => t.value))];
    group.forEach((t, k) => {
      const checks = t.validation.checks.filter((c) => !isDup(c));
      if (values.length > 1) checks.push(check('DUPLICATE_CONFLICTING', `readings disagree: ${values.join(' vs ')}`));
      else if (k > 0) checks.push(check('DUPLICATE_TEST', 'same value reported again'));
      t.validation = { status: statusOf(checks), checks };
    });
  }

  const rowsRead = tests.length;

  const has = (t, code) => t.validation.checks.some((c) => c.code === code);
  const isNoise = (t) => has(t, 'NAME_AMBIGUOUS') && (has(t, 'VALUE_IMPLAUSIBLE') || has(t, 'VALUE_UNPARSEABLE'));
  tests.splice(0, tests.length, ...tests.filter((t) => t.canonicalId && !isNoise(t)));
  const rowsDiscarded = rowsRead - tests.length;

  const passed = tests.filter((t) => t.validation.status === 'pass');
  const warned = tests.filter((t) => t.validation.status === 'warn');
  const failed = tests.filter((t) => t.validation.status === 'fail');

  const engineRelevant = tests.filter((t) => t.engineField);

  explainChecks(tests);
  const vitals = parseVitals(lines);
  const form = buildForm(tests, meta, vitals);

  return {
    schemaVersion: SCHEMA['x-schemaVersion'],
    summary: summariseForm(form),
    messages: buildMessages(form, meta, tests),
    report: {
      labName: meta.labName || null,
      labAccreditation: meta.labAccreditation || null,
      accessionId: meta.accessionId || null,
      referringDoctor: meta.referringDoctor || null,
      patientNameOnReport: meta.patientNameOnReport || null,
      patientAgeOnReport: meta.patientAgeOnReport ?? null,
      patientSexOnReport: meta.patientSexOnReport || null,
      bloodGroupOnReport: meta.bloodGroup || null,
      collectedAt: meta.collectedAt || null,
      reportedAt: meta.reportedAt || null,
      panelsDetected: [...new Set(tests.filter((t) => t.canonicalId).map((t) => CATALOGUE[t.canonicalId].panel))],
    },
    form,
    formPrefill: buildFormPrefill(form),
    intake: buildIntake(form, meta, tests, vitals),
    tests,
    validation: {
      status: failed.length ? 'fail' : warned.length ? 'warn' : 'pass',
      testsTotal: tests.length,
      testsPassed: passed.length,
      testsWarned: warned.length,
      testsFailed: failed.length,
      documentChecks: [],
    },
    review: {
      required: true,
      reason: engineRelevant.length ? 'engine_relevant_value' : 'default_policy',
      state: 'pending',
      reviewer: null,
      reviewedAt: null,
      corrections: [],
    },
    enginePayload: null,
    source: {
      mediaId: `local:${path.basename(file)}`,
      mimeType: ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg',
      sha256: require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      pageCount: pageCount,
      sizeBytes: fs.statSync(file).size,
      uploadedAt: new Date().toISOString(),
      userId: opts.userId || 'poc-user',
      profileId: null,
    },
    extraction: {
      ocrEngine: engine,
      ocrEngineVersion: opts.engineVersion || 'unknown',
      structuringMethod: 'rules',
      llmModel: null,
      pipelineVersion: PIPELINE_VERSION,
      catalogueVersion: SCHEMA['x-schemaVersion'],
      extractedAt: new Date().toISOString(),
      processingMs: Date.now() - started,
      pagesProcessed: pageCount,
      linesRead: lines.length,
      rowsDiscarded,
      overallConfidence:
        tests.length === 0
          ? 0
          : Math.round((tests.reduce((a, t) => a + t.confidence.ocr, 0) / tests.length) * 1000) / 1000,
    },
    identityMatch: { nameSimilarity: null, ageConsistent: null, sexConsistent: null, decision: 'not_checked', notes: 'PoC has no account to match against.' },
  };
}

const FORM = SCHEMA['x-assessmentForm'];

const VITAL_PATTERNS = {
  height: /^(?:height|ht)\s*[:\-]\s*(\d{2,3}(?:\.\d+)?)\s*(?:cm|cms)\b/im,
  weight: /^(?:weight|wt)\s*[:\-]\s*(\d{2,3}(?:\.\d+)?)\s*(?:kg|kgs)\b/im,
  waist: /^waist(?:\s+circumference)?\s*[:\-]\s*(\d{2,3}(?:\.\d+)?)\s*(?:cm|cms)\b/im,
  bp: /^(?:bp|blood\s+pressure)\s*[:\-]\s*(\d{2,3})\s*\/\s*(\d{2,3})\b/im,
  heartRate: /^(?:pulse(?:\s+rate)?|heart\s+rate|hr)\s*[:\-]\s*(\d{2,3})\s*(?:bpm|\/\s*min|beats)/im,
  spo2: /^(?:spo2|sp02|spo₂|oxygen\s+saturation|o2\s+saturation)\s*[:\-]\s*(\d{2,3})\s*%/im,
  temperature: /^(?:temperature|temp|body\s+temperature)\s*[:\-]\s*(\d{2,3}(?:\.\d+)?)\s*°?\s*([fc])\b/im,
  bmi: /^bmi\s*[:\-]\s*(\d{1,2}(?:\.\d+)?)\s*(?:kg\/m2|kg\/m²)?/im,
};

const VITAL_BOUNDS = { heartRate: [20, 250], spo2: [50, 100], temperature: { f: [90, 110], c: [32, 43] }, bmi: [10, 80] };

function parseVitals(lines) {
  const found = {};
  for (const line of lines) {
    for (const [name, re] of Object.entries(VITAL_PATTERNS)) {
      const m = re.exec(line.text);
      if (!m) continue;
      const where = { pageNumber: line.pageNumber || 1, lineNumber: line.lineNumber, readAs: line.text.slice(0, 80) };
      if (name === 'bp') {
        if (!found.sbp) found.sbp = { value: Number(m[1]), ...where };
        if (!found.dbp) found.dbp = { value: Number(m[2]), ...where };
      } else if (!found[name]) {
        const value = Number(m[1]);
        if (name === 'temperature') {
          const unit = m[2].toLowerCase();
          const [lo, hi] = VITAL_BOUNDS.temperature[unit];
          if (value >= lo && value <= hi) found.temperature = { value, unit: unit === 'f' ? '°F' : '°C', ...where };
        } else if (VITAL_BOUNDS[name]) {
          const [lo, hi] = VITAL_BOUNDS[name];
          if (value >= lo && value <= hi) found[name] = { value, ...where };
        } else {
          found[name] = { value, ...where };
        }
      }
    }
  }
  return found;
}

const CHECK_TEXT = {
  OCR_LOW_CONFIDENCE: () => 'The text was hard to read here, so the value may be wrong',
  NAME_UNRESOLVED: (t) => `"${t.raw.nameText}" is not a test the assessment uses`,
  NAME_AMBIGUOUS: (t) => `"${t.raw.nameText}" looks like ${t.displayName}, but the match is not certain`,
  VALUE_UNPARSEABLE: (t) => `"${t.raw.valueText}" is not a number`,
  VALUE_IMPLAUSIBLE: (t) => `${t.value} is not a possible value for ${t.displayName}`,
  VALUE_ORDER_OF_MAGNITUDE_SUSPECT: (t) => `${t.value} is far outside the range printed on the report, possibly a misread digit`,
  DECIMAL_SEPARATOR_SUSPECT: () => 'The decimal point may have been misread',
  UNIT_MISSING: () => 'No unit was printed next to the value',
  UNIT_UNRECOGNISED: (t) => `The unit "${t.raw.unitText}" was not recognised`,
  UNIT_NOT_VALID_FOR_TEST: (t) => `${t.unit} is not a unit ${t.displayName} is reported in`,
  UNIT_ASSUMED: () => 'The unit was assumed, not read',
  REFERENCE_RANGE_MISSING: () => 'No reference range was printed',
  REFERENCE_RANGE_UNPARSEABLE: () => 'The printed reference range could not be read',
  VALUE_OUTSIDE_REPORT_RANGE: () => 'The value is outside the reference range printed on the report',
  FLAG_CONTRADICTS_VALUE: () => 'The high/low flag on the report does not match the value read',
  DUPLICATE_TEST: () => 'This test appears more than once on the report, with the same value',
  DUPLICATE_CONFLICTING: () => 'This test appears more than once on the report with different values',
  LAYOUT_UNCERTAIN: () => 'This part of the report is laid out so that the value may belong to a neighbouring test, and no second reading confirmed it',
  CONFIRMED_BY_SECOND_READING: () => 'The same value is printed elsewhere on the report, which confirms it',
  COLUMN_MISALIGNED: () => 'On this part of the report the values are printed out of line with the test names, so the value may belong to another test',
  DATE_MISSING: () => 'No sample collection date was found on the report',
  DATE_IN_FUTURE: () => 'The collection date is in the future',
  DATE_STALE: () => 'The sample was collected more than a year ago',
  PANEL_INCOMPLETE: () => 'Part of this panel is missing from the report',
  IDENTITY_UNCERTAIN: () => 'The name on the report could not be checked against the account',
  IDENTITY_MISMATCH: () => 'The name on the report does not match the account',
  CRITICAL_VALUE_DETECTED: () => 'This value is in a range that needs prompt medical attention',
};

function explainChecks(tests) {
  for (const t of tests) {
    for (const c of t.validation.checks) {
      const make = CHECK_TEXT[c.code];
      const detail = c.message && !/^"[^"]*"$/.test(c.message) ? c.message : null;
      if (make) {
        c.detail = c.detail || (detail ? { note: detail } : null);
        c.message = make(t);
      }
    }
  }
}

function inSentence(label) {
  return /^[A-Z][a-z]/.test(label) && !/^Hb/.test(label) ? label[0].toLowerCase() + label.slice(1) : label;
}

function humanDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

function usable(t) {
  if (t.validation.status === 'pass') return true;
  if (t.validation.status !== 'warn') return false;
  return t.validation.checks.every((ch) => ch.severity === 'info' || ch.code === 'DATE_MISSING');
}

function fromTest(field, tests) {
  const entry = CATALOGUE[field.source.test];
  const rows = tests.filter((t) => t.canonicalId === field.source.test);
  const passing = rows.filter(usable);
  const values = [...new Set(passing.map((t) => t.value))];
  const best = passing[0] || rows[0];
  const source = best
    ? { from: 'report', pageNumber: best.raw.pageNumber, lineNumber: best.raw.lineNumber, readAs: `${best.raw.nameText} ${best.raw.valueText} ${best.raw.unitText || ''}`.trim() }
    : null;
  if (!rows.length) return { status: 'not_found', reason: 'not on the report' };
  const blocked =
    !passing.length ? 'the value could not be read reliably'
    : values.length > 1 ? `the report shows different values (${values.join(' and ')})`
    : passing[0].qualifier ? `the report gives it as ${passing[0].qualifier}${values[0]}, not an exact number`
    : passing[0].unit !== entry.canonicalUnit ? `it is in ${passing[0].unit}, and the form needs ${entry.canonicalUnit}`
    : field.range && (values[0] < field.range[0] || values[0] > field.range[1]) ? `${values[0]} is outside what the form accepts (${field.range[0]}-${field.range[1]})`
    : null;
  if (blocked) return { status: 'check', reason: blocked, source };
  return { status: 'filled', value: String(values[0]), source };
}

function fromHeader(field, meta) {
  const v = meta[field.source.header];
  if (v == null || v === '') return null;
  if (field.range && (Number(v) < field.range[0] || Number(v) > field.range[1])) return null;
  if (field.options && !field.options.some((o) => o.value === String(v))) return null;
  return { status: 'filled', value: String(v), source: { from: 'report header' } };
}

function fromVital(field, vitals) {
  const v = vitals[field.source.vital];
  if (!v) return null;
  if (field.range && (v.value < field.range[0] || v.value > field.range[1])) return null;
  return { status: 'filled', value: String(v.value), source: { from: 'report', pageNumber: v.pageNumber, lineNumber: v.lineNumber, readAs: v.readAs } };
}

function buildForm(tests, meta, vitals) {
  const known = {};
  const resolved = FORM.fields.map((field) => {
    let r = null;
    if (field.source && field.source.test) r = fromTest(field, tests);
    else if (field.source && field.source.header) r = fromHeader(field, meta);
    else if (field.source && field.source.vital) r = fromVital(field, vitals);
    if (!r) r = { status: 'ask_user' };
    if (r.status === 'filled') known[field.key] = r.value;
    return { field, r };
  });

  const out = resolved.map(({ field, r }) => {
    let status = r.status;
    let message = null;
    if (field.showIf) {
      const [dep, want] = Object.entries(field.showIf)[0];
      if (known[dep] !== undefined && known[dep] !== want) status = 'not_applicable';
    }
    if (status === 'not_found') {
      message = `We could not find your ${inSentence(field.label)} on this report. ${field.required ? 'It is needed for your VITAL Score. ' : ''}Please upload ${field.uploadHint}, or enter it yourself.`;
    } else if (status === 'check') {
      message = `We found your ${inSentence(field.label)}, but ${r.reason}. Please check the value on your report and enter it.`;
    } else if (status === 'ask_user') {
      message = field.question || `Please enter your ${inSentence(field.label)}.`;
    }
    let hint = null;
    if (field.key === 'crp' && status === 'not_found' && tests.some((t) => t.canonicalId === 'crp')) {
      message = 'Your report has a standard CRP test. The VITAL Score uses high-sensitivity CRP (hs-CRP), which is a different test. Upload an hs-CRP report, or leave this blank.';
    }
    if (field.key === 'microalbumin') {
      const acr = tests.find((t) => t.canonicalId === 'urine_acr' && t.validation.status === 'pass');
      if (acr) hint = `Your report shows a urine albumin-to-creatinine ratio (ACR) of ${acr.qualifier || ''}${acr.value} ${acr.unit}. Use it to answer the microalbuminuria question.`;
    }
    if (field.key === 'dmStatus' && tests.some((t) => ['hba1c', 'fasting_glucose'].includes(t.canonicalId))) {
      hint = "Your report has blood sugar results, but please answer diabetes status from your doctor's diagnosis. We do not decide it from lab values.";
    }
    const item = {
      key: field.key,
      label: field.label,
      step: field.step,
      required: field.required,
      type: field.type,
      unit: field.unit || null,
      value: status === 'filled' ? r.value : null,
      status,
      source: status === 'filled' || status === 'check' ? r.source || null : null,
      message,
    };
    if (hint) item.hint = hint;
    if (field.showIf && status !== 'not_applicable') {
      const [dep, want] = Object.entries(field.showIf)[0];
      item.showIf = field.showIf;
      if (known[dep] === undefined) item.conditional = `only if ${dep} is ${want}`;
    }
    if (field.range) item.range = field.range;
    if (field.options) item.options = field.options;
    return item;
  });

  return {
    steps: FORM.steps.map((s) => ({ step: s.step, title: s.title, fields: out.filter((f) => f.step === s.step) })),
  };
}

function summariseForm(form) {
  const fields = form.steps.flatMap((s) => s.fields).filter((f) => f.status !== 'not_applicable');
  const count = (st) => fields.filter((f) => f.status === st).length;
  const missingRequired = fields.filter((f) => f.required && f.status !== 'filled').map((f) => f.key);
  return {
    status: missingRequired.length ? 'needs_input' : 'ready_to_review',
    fieldsTotal: fields.length,
    fieldsRequired: fields.filter((f) => f.required).length,
    filledFromReport: count('filled'),
    needsChecking: count('check'),
    notFoundOnReport: count('not_found'),
    needYourInput: count('ask_user'),
    requiredStillMissing: missingRequired,
  };
}

function buildMessages(form, meta, tests) {
  const msgs = [];
  const add = (level, code, text, field = null) => msgs.push({ level, code, field, text });
  const fields = form.steps.flatMap((s) => s.fields);
  const who = [meta.patientNameOnReport, meta.patientAgeOnReport != null ? `${meta.patientAgeOnReport} years` : null, meta.patientSexOnReport]
    .filter(Boolean)
    .join(', ');
  if (who) add('info', 'REPORT_IDENTITY', `This report is for ${who}. Check that it is yours, or belongs to the family member you are filling this in for.`);
  const when = humanDate(meta.collectedAt);
  if (when) {
    add('info', 'REPORT_DATE', `Sample collected on ${when}.`);
    if (Date.now() - Date.parse(meta.collectedAt) > 365 * 24 * 3600 * 1000) {
      add('warning', 'REPORT_OLD', 'This report is more than a year old. A recent report gives a more accurate VITAL Score.');
    }
  } else {
    add('warning', 'REPORT_DATE_MISSING', 'We could not find the date the sample was collected. Please check the report date before you continue.');
  }
  if (!tests.length) {
    add('action', 'NOTHING_FOUND', 'We could not find any test results we use on this report. Please upload a lab report that includes a lipid profile (total cholesterol and HDL).');
  }
  const filled = fields.filter((f) => f.status === 'filled');
  if (filled.length) add('info', 'FILLED', `We filled ${filled.length} fields from your report: ${filled.map((f) => f.label).join(', ')}. Please check them before you continue.`);
  for (const f of fields.filter((x) => x.status === 'not_found' || x.status === 'check')) {
    add(f.status === 'check' || f.required ? 'action' : 'info', f.status === 'check' ? 'CHECK_VALUE' : 'NOT_ON_REPORT', f.message, f.key);
  }
  for (const f of fields.filter((x) => x.status === 'ask_user' && x.hint)) add('info', 'HINT', f.hint, f.key);
  const ask = fields.filter((f) => f.status === 'ask_user' && !f.conditional);
  const needed = ask.filter((f) => f.required);
  const optional = ask.filter((f) => !f.required);
  if (needed.length) add('action', 'ANSWER_REQUIRED', `Please fill these in yourself. They are needed for your VITAL Score and are not on a lab report: ${needed.map((f) => f.label).join(', ')}.`);
  if (optional.length) add('info', 'ANSWER_OPTIONAL', `Optional, if you know them: ${optional.map((f) => f.label).join(', ')}.`);
  return msgs;
}

function formValue(form, key) {
  const f = form.steps.flatMap((s) => s.fields).find((x) => x.key === key);
  return f && f.status === 'filled' ? f.value : null;
}

function describeRange(r) {
  if (!r) return null;
  if (r.low != null && r.high != null) return `${r.low}-${r.high}`;
  if (r.high != null) return `below ${r.high}`;
  if (r.low != null) return `above ${r.low}`;
  return r.text || null;
}

function buildLabResults(tests, meta) {
  const seen = new Set();
  const out = [];
  for (const t of tests) {
    if (!usable(t) || seen.has(t.canonicalId)) continue;
    seen.add(t.canonicalId);
    out.push({
      test: t.canonicalId,
      name: t.displayName,
      value: t.value,
      qualifier: t.qualifier,
      unit: t.unit,
      referenceRange: describeRange(t.referenceRange),
      flag: t.abnormalFlag,
      collectedAt: t.specimenCollectedAt || meta.collectedAt || null,
      source: { pageNumber: t.raw.pageNumber, lineNumber: t.raw.lineNumber },
    });
  }
  return out;
}

const STORAGE = SCHEMA['x-storageMap'].items;

const TEST_TO_ITEM = {
  total_cholesterol: 'tc',
  hdl_cholesterol: 'hdl',
  ldl_cholesterol: 'ldl',
  triglycerides: 'trig',
  hba1c: 'hba1c',
  fasting_glucose: 'fbg',
  hs_crp: 'crp',
  egfr: 'egfr',
  crp: 'crp_standard',
};

function buildStorage(form, meta, labResults) {
  const entries = [];
  const add = (item, label, value) => {
    const where = STORAGE[item] || (CATALOGUE[item] ? { status: 'no_store', stores: [] } : null);
    if (!where || entries.some((e) => e.item === item)) return;
    const entry = { item, label, value: String(value), status: where.status, stores: where.stores };
    if (where.note) entry.note = where.note;
    entries.push(entry);
  };
  for (const f of form.steps.flatMap((s) => s.fields)) if (f.status === 'filled') add(f.key, f.label, f.value);
  if (meta.bloodGroup) add('bloodGroup', 'Blood group', meta.bloodGroup);
  for (const r of labResults) add(TEST_TO_ITEM[r.test] || r.test, r.name, `${r.qualifier || ''}${r.value} ${r.unit}`.trim());
  const count = {};
  for (const e of entries) count[e.status] = (count[e.status] || 0) + 1;
  return { summary: count, items: entries };
}

function buildUnconfirmed(tests, labResults) {
  const doubt = new Set(['LAYOUT_UNCERTAIN', 'UNIT_MISSING', 'UNIT_UNRECOGNISED', 'UNIT_NOT_VALID_FOR_TEST', 'NAME_AMBIGUOUS', 'DUPLICATE_CONFLICTING', 'OCR_LOW_CONFIDENCE']);
  const have = new Set(labResults.map((r) => r.test));
  const byTest = new Map();
  for (const t of tests) {
    if (!t.canonicalId || have.has(t.canonicalId)) continue;
    const problems = t.validation.checks.filter((c) => c.severity !== 'info' && c.code !== 'DATE_MISSING');
    if (!problems.length || problems.some((c) => !doubt.has(c.code))) continue;
    if (!byTest.has(t.canonicalId)) byTest.set(t.canonicalId, []);
    byTest.get(t.canonicalId).push({ t, problems });
  }
  const out = [];
  for (const [test, list] of byTest) {
    const readings = [];
    for (const { t } of list) {
      const text = `${t.raw.valueText}${t.raw.unitText ? ' ' + t.raw.unitText : ''}`;
      if (!readings.some((r) => r.readAs === text)) readings.push({ readAs: text, pageNumber: t.raw.pageNumber, lineNumber: t.raw.lineNumber });
    }
    out.push({
      test,
      name: list[0].t.displayName,
      readAs: readings.map((r) => (readings.length > 1 ? `${r.readAs} (page ${r.pageNumber})` : r.readAs)).join(' or '),
      reason: [...new Set(list.flatMap((x) => x.problems.map((c) => c.message)))].join('; '),
      source: { pageNumber: readings[0].pageNumber, lineNumber: readings[0].lineNumber },
    });
  }
  return out;
}

function buildIntake(form, meta, tests, reportVitals = {}) {
  const num = (k) => (formValue(form, k) == null ? null : Number(formValue(form, k)));
  const notes = [];

  const profile = {};
  const sex = formValue(form, 'sex');
  if (sex === 'male' || sex === 'female') profile.gender = sex;
  if (meta.bloodGroup) profile.bloodGroup = meta.bloodGroup;
  if (num('height') != null) profile.height = num('height');
  if (num('weight') != null) profile.weight = num('weight');

  const vitals = {};
  if (num('sbp') != null && num('dbp') != null) vitals.bloodPressure = { systolic: num('sbp'), diastolic: num('dbp') };
  if (num('weight') != null) vitals.weight = num('weight');
  if (reportVitals.heartRate) vitals.heartRate = reportVitals.heartRate.value;
  if (reportVitals.spo2) vitals.spo2 = reportVitals.spo2.value;
  const vitalsOnReport = {};
  for (const k of ['heartRate', 'spo2', 'temperature', 'bmi']) {
    if (reportVitals[k]) vitalsOnReport[k] = reportVitals[k].unit ? { value: reportVitals[k].value, unit: reportVitals[k].unit } : reportVitals[k].value;
  }
  if (Object.keys(vitals).length) {
    notes.push('POST /api/vitals stamps every reading with the time it is saved, so readings from a report are dated today, not on the collection date.');
  }
  if (formValue(form, 'fbg') != null) {
    notes.push('Fasting glucose is kept in labResults and not sent as a vitals reading: the vitals store does not record whether glucose was fasting.');
  }

  const assessment = {};
  for (const f of form.steps.flatMap((s) => s.fields)) if (f.status === 'filled') assessment[f.key] = f.value;
  if (assessment.hba1c || assessment.fbg) {
    notes.push('calculate-score currently reads only diabetes status from the glycaemic step; HbA1c and fasting glucose are saved with the form but do not change the score.');
  }
  if (assessment.egfr) notes.push('calculate-score uses eGFR only to mark kidney function below 60; the number itself is not stored.');
  if (assessment.trig) notes.push('calculate-score does not store triglycerides.');

  const labResults = buildLabResults(tests, meta);
  const unconfirmedResults = buildUnconfirmed(tests, labResults);
  if (labResults.length) notes.push('The backend has no store for lab results yet; labResults is ready for one.');

  const asOf = humanDate(meta.collectedAt);
  const facts = labResults.map((r) => {
    const range = r.referenceRange ? `, reference ${r.referenceRange}` : '';
    const flag = r.flag && r.flag !== 'unknown' ? `, flagged ${r.flag}` : '';
    return `${r.name}: ${r.qualifier || ''}${r.value} ${r.unit}${range}${flag}${asOf ? ` (collected ${asOf})` : ''}`;
  });
  const who = [
    meta.patientAgeOnReport != null ? `${meta.patientAgeOnReport} years` : null,
    meta.patientSexOnReport,
    meta.bloodGroup ? `blood group ${meta.bloodGroup}` : null,
  ].filter(Boolean);
  const vf = [];
  if (vitalsOnReport.heartRate) vf.push(`heart rate ${vitalsOnReport.heartRate} bpm`);
  if (vitalsOnReport.spo2) vf.push(`SpO2 ${vitalsOnReport.spo2}%`);
  if (vitalsOnReport.temperature) vf.push(`temperature ${vitalsOnReport.temperature.value} ${vitalsOnReport.temperature.unit}`);
  if (vitalsOnReport.bmi) vf.push(`BMI ${vitalsOnReport.bmi}`);
  for (const k of ['sbp', 'height', 'weight']) if (formValue(form, k) != null) vf.push(k === 'sbp' ? `blood pressure ${formValue(form, 'sbp')}/${formValue(form, 'dbp') || '?'} mmHg` : `${k} ${formValue(form, k)} ${k === 'height' ? 'cm' : 'kg'}`);
  if (vf.length) facts.unshift(`Vitals on report: ${vf.join(', ')}${asOf ? ` (${asOf})` : ''}`);
  if (who.length) facts.unshift(`Patient on report: ${who.join(', ')}`);

  return {
    requiresConfirmation: true,
    storage: buildStorage(form, meta, labResults),
    profile: Object.keys(profile).length ? { endpoint: 'PATCH /api/users/updateMe', body: { profile } } : null,
    familyProfile: profile.gender ? { endpoint: 'PATCH /api/users/family/:profileId', body: { gender: profile.gender } } : null,
    vitals: Object.keys(vitals).length ? { endpoint: 'POST /api/vitals', body: vitals, measuredAt: meta.collectedAt || null } : null,
    assessment: { endpoint: 'POST /api/vitals/calculate-score', body: assessment, missingRequired: summariseForm(form).requiredStillMissing },
    labResults,
    unconfirmedResults,
    vitalsOnReport,
    ragContext: { asOf: meta.collectedAt || null, facts },
    notes,
  };
}

function buildFormPrefill(form) {
  const fields = {};
  const sources = {};
  const skipped = {};
  for (const f of form.steps.flatMap((s) => s.fields)) {
    if (f.status === 'filled') {
      fields[f.key] = f.value;
      sources[f.key] = f.source;
    } else if (f.status === 'check' || f.status === 'not_found') {
      skipped[f.key] = f.message;
    }
  }
  return { fields, sources, skipped };
}

function summarise(doc) {
  const icon = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
  const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
  console.log(
    `\n${doc.extraction.ocrEngine} · ${doc.tests.length} rows · ` +
      `mean OCR confidence ${doc.extraction.overallConfidence} · ${doc.extraction.processingMs}ms`
  );
  console.log(
    `${pad('READ AS', 26)}${pad('CANONICAL', 20)}${pad('VALUE', 14)}${pad('', 6)}CHECKS`
  );
  console.log('-'.repeat(104));
  for (const t of doc.tests) {
    console.log(
      pad(t.raw.nameText, 26) +
        pad(t.canonicalId || '—', 20) +
        pad(t.value === null ? '?' : `${t.value} ${t.unit || '?'}`, 14) +
        pad(icon[t.validation.status], 6) +
        t.validation.checks.map((c) => c.code).join(', ')
    );
  }
  const eligible = doc.tests.filter((t) => t.engineField && t.validation.status === 'pass');
  console.log('-'.repeat(104));
  console.log(
    `document: ${doc.validation.status.toUpperCase()} · ` +
      `${doc.validation.testsPassed} pass / ${doc.validation.testsWarned} warn / ${doc.validation.testsFailed} fail`
  );
  console.log(
    `engine-eligible after validation: ${eligible.length}` +
      (eligible.length ? ` (${eligible.map((t) => t.canonicalId).join(', ')})` : '')
  );
  console.log(`enginePayload: ${doc.enginePayload === null ? 'null — review required before any write' : 'populated'}\n`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node extract.js <image|pdf> [--engine tesseract|pdftotext] [--out file.json]');
    process.exit(1);
  }
  const engineArg = args.indexOf('--engine');
  const outArg = args.indexOf('--out');

  const fixturesDir = path.join(__dirname, '..', 'test', 'fixtures');
  const gtPath = path.join(fixturesDir, 'ground_truth.json');
  const isFixture = path.dirname(path.resolve(file)) === fixturesDir;
  const reportMeta = isFixture && fs.existsSync(gtPath) ? JSON.parse(fs.readFileSync(gtPath, 'utf8')).report : undefined;

  let doc;
  try {
    doc = extract(path.resolve(file), {
      engine: engineArg > -1 ? args[engineArg + 1] : undefined,
      reportMeta,
    });
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }

  summarise(doc);

  if (outArg > -1) {
    const out = path.resolve(args[outArg + 1]);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(doc, null, 2));
    console.log(`wrote ${out}`);
  }
}

module.exports = { extract, resolveName, normaliseUnit, parseValue, parseReference, parseRows, parseTextOrder, parseHeader, parseVitals, buildForm, buildIntake, buildMessages, summariseForm, validateTest, CATALOGUE, FORM, STORAGE, TEST_TO_ITEM };
