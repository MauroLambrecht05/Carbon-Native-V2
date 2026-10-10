import { PlatformFault } from '@carbon/contracts/platform';

const fail = (message: string): never => { throw new PlatformFault('validation', message); };
export interface CsvCell { readonly text: string; readonly quoted: boolean }

/** Strict JSON decoding rejects duplicate keys before they can discard source data. */
export function parseImportJson(text: string): unknown {
  let at = 0;
  const whitespace = () => { while (at < text.length && /[ \n\r\t]/.test(text[at]!)) at++; };
  const string = (): string => {
    if (text[at] !== '"') fail('Invalid JSON import');
    const start = at++;
    while (at < text.length) {
      if (text[at] === '\\') { at += 2; continue; }
      if (text[at++] === '"') return JSON.parse(text.slice(start, at));
    }
    return fail('Invalid JSON import');
  };
  const value = (depth: number): unknown => {
    if (depth > 20) fail('Import JSON exceeds the nesting limit');
    whitespace();
    if (text[at] === '"') return string();
    if (text[at] === '{') {
      at++; whitespace(); const entries: [string, unknown][] = []; const keys = new Set<string>();
      if (text[at] === '}') { at++; return {}; }
      while (true) {
        whitespace(); const key = string();
        if (keys.has(key)) fail('Duplicate JSON object keys are not allowed'); keys.add(key);
        whitespace(); if (text[at++] !== ':') fail('Invalid JSON import');
        entries.push([key, value(depth + 1)]); whitespace();
        if (text[at] === '}') { at++; return Object.fromEntries(entries); }
        if (text[at++] !== ',') fail('Invalid JSON import');
      }
    }
    if (text[at] === '[') {
      at++; whitespace(); const items: unknown[] = [];
      if (text[at] === ']') { at++; return items; }
      while (true) {
        if (depth === 0 && items.length >= 1000) fail('Imports support at most 1000 rows');
        items.push(value(depth + 1)); whitespace();
        if (text[at] === ']') { at++; return items; }
        if (text[at++] !== ',') fail('Invalid JSON import');
      }
    }
    const start = at;
    while (at < text.length && !/[\s,\]}]/.test(text[at]!)) at++;
    if (at === start) fail('Invalid JSON import');
    return JSON.parse(text.slice(start, at));
  };
  try { const result = value(0); whitespace(); if (at !== text.length) fail('Invalid JSON import'); return result; }
  catch (error) { if (error instanceof PlatformFault) throw error; return fail('Invalid JSON import'); }
}

/** CSV retains quote evidence so an unquoted \N is distinct from literal text. */
export function parseImportCsv(input: string): CsvCell[][] {
  const text = input.startsWith('\uFEFF') ? input.slice(1) : input;
  const records: CsvCell[][] = []; let record: CsvCell[] = []; let at = 0;
  while (at < text.length) {
    let cell = ''; const quoted = text[at] === '"';
    if (quoted) {
      at++; let closed = false;
      while (at < text.length) {
        const char = text[at++]!;
        if (char !== '"') { cell += char; continue; }
        if (text[at] === '"') { cell += '"'; at++; continue; }
        closed = true; break;
      }
      if (!closed || (at < text.length && ![',', '\r', '\n'].includes(text[at]!))) fail('Invalid CSV quoting');
    } else {
      while (at < text.length && ![',', '\r', '\n'].includes(text[at]!)) {
        if (text[at] === '"') fail('Invalid CSV quoting'); cell += text[at++]!;
      }
    }
    record.push({ text: cell, quoted });
    if (record.length > 100) fail('Imports support at most 100 source columns');
    if (text[at] === ',') {
      at++; if (at < text.length) continue;
      record.push({ text: '', quoted: false });
      if (record.length > 100) fail('Imports support at most 100 source columns');
    } else if (text[at] === '\r') { at++; if (text[at] === '\n') at++; }
    else if (text[at] === '\n') at++;
    records.push(record); record = [];
    if (records.length > 1001) fail('Imports support at most 1000 rows');
  }
  return records;
}
