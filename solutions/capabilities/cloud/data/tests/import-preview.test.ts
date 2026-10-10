import { expect, test } from 'bun:test';
import { previewImport } from '../domain/ImportPreview.ts';
import { parseImportCsv, parseImportJson } from '../domain/ImportSource.ts';
import { parseComponent, type DataImportInput, type DataTable } from '@carbon/contracts/platform';

const table: DataTable = { id: '11111111-1111-4111-8111-111111111111', revision: '3', definition: {
  name: 'records', policies: { enabled: false, rules: [] }, columns: [
    { name: 'body', type: 'text', nullable: false }, { name: 'amount', type: 'decimal', nullable: false },
    { name: 'count', type: 'integer', nullable: true }, { name: 'active', type: 'boolean', nullable: true },
    { name: 'tags', type: 'text[]', nullable: true }, { name: 'numbers', type: 'integer[]', nullable: true },
    { name: 'payload', type: 'jsonb', nullable: true }, { name: 'id', type: 'uuid', nullable: false, default: { kind: 'uuid' } },
    { name: 'created', type: 'timestamp', nullable: false, default: { kind: 'now' } },
  ],
} };
const json = (rows: unknown[]): DataImportInput => ({ format: 'json', text: JSON.stringify(rows), mapping: {}, conflict: 'error', atomic: true });

test('JSON import review preserves exact values, validates omissions and never materializes defaults', () => {
  const input = json([
    { body: 'valid', amount: '9007199254740993.123456789', count: '9223372036854775807', numbers: ['9223372036854775807'] },
    { body: 'bad number', amount: 9007199254740993 }, { amount: '1' }, { body: 'null required', amount: null },
    { body: 'bad array', amount: '1', numbers: [1] }, { body: 'unknown', amount: '1', private_unknown: 'sensitive input' }, null,
  ]);
  const result = previewImport(table, input); expect(result.revision).toBe('3'); expect(result.validation).toBe('structure');
  expect(result.total).toBe(7); expect(result.valid).toBe(1); expect(result.invalid).toBe(6);
  expect(result.samples).toEqual([{ row: 1, values: JSON.parse(input.text)[0] }]);
  expect(result.samples[0]!.values).not.toHaveProperty('id'); expect(result.samples[0]!.values).not.toHaveProperty('created');
  expect(result.errors.map(error => error.code)).toEqual(['invalid_value', 'missing_column', 'invalid_value', 'invalid_value', 'unknown_column', 'row_shape']);
  expect(JSON.stringify(result.errors)).not.toContain('sensitive input'); expect(JSON.stringify(result.errors)).not.toContain('9007199254740993');
  expect(previewImport(table, json([]))).toMatchObject({ total: 0, valid: 0, invalid: 0, samples: [], errors: [] });
});

test('CSV review handles quoted delimiters, newlines, empty strings, explicit nulls and typed JSON cells', () => {
  const record = ['a, "quote"\nline', '9007199254740993.123', '9223372036854775807', 'true', '["comma,value","NULL"]', '["9223372036854775807"]', '{"nested":"value"}'];
  const csv = (fields: string[]) => fields.map(value => '"' + value.replaceAll('"', '""') + '"').join(',');
  const input: DataImportInput = { format: 'csv', text: '\uFEFFbody,amount,count,active,tags,numbers,payload\r\n' + csv(record) + '\r\n,0,\\N,false,[],[],null\n', mapping: {}, conflict: 'error', atomic: true };
  const result = previewImport(table, input); expect(result.valid).toBe(2); expect(result.invalid).toBe(0);
  expect(result.samples[0]!.values).toEqual({ body: record[0], amount: record[1], count: record[2], active: true, tags: ['comma,value', 'NULL'], numbers: ['9223372036854775807'], payload: { nested: 'value' } });
  expect(result.samples[1]!.values).toEqual({ body: '', amount: '0', count: null, active: false, tags: [], numbers: [], payload: null });
  const literal = previewImport(table, { ...input, text: 'body,amount\n"\\N",1\n\\N,1' });
  expect(literal.samples[0]!.values.body).toBe('\\N'); expect(literal.errors[0]!.row).toBe(2);
  expect(previewImport(table, { ...input, text: 'body,amount,active\na,1,TRUE' }).invalid).toBe(1);
  expect(previewImport(table, { ...input, text: 'body,amount\na,1,extra\nb,2' }).errors[0]!.code).toBe('row_shape');
  expect(parseImportCsv('a,b\n1,')[1]).toEqual([{ text: '1', quoted: false }, { text: '', quoted: false }]);
});

test('source parsing rejects malformed quoting, duplicate keys, ambiguous headers and mapping collisions', () => {
  for (const text of ['[{"body":"a","body":"b"}]', '[{"body":"a","\\u0062ody":"b"}]', '[{"nested":{"key":1,"key":2}}]', '[1,]', '[{}] garbage', '[{"x":01}]']) {
    expect(() => parseImportJson(text)).toThrow();
  }
  for (const text of ['a\n"unclosed', 'a\n"closed"junk', 'a\nnot"quoted']) expect(() => parseImportCsv(text)).toThrow('quot');
  const csv: DataImportInput = { format: 'csv', text: 'a,a\n1,2', mapping: {}, conflict: 'error', atomic: true };
  expect(() => previewImport(table, csv)).toThrow('headers');
  expect(() => previewImport(table, { ...csv, text: ',b\n1,2' })).toThrow('headers');
  expect(() => previewImport(table, { ...json([{ body: 'text', amount: '1' }]), mapping: { missing: 'body' } })).toThrow('unknown source');
  expect(() => previewImport(table, { ...json([{ a: 'text', b: '1' }]), mapping: { a: 'body', b: 'body' } })).toThrow('one target');
  const mapped = previewImport(table, { ...json([{ 'Human label': 'text', amount: '1', ignored: { unsafe: 'discarded' } }]), mapping: { 'Human label': 'body', ignored: '' } });
  expect(mapped.samples[0]!.values).toEqual({ body: 'text', amount: '1' });
  const prototype = parseImportJson('[{"constructor":"text","__proto__":{"polluted":true}}]') as Record<string, unknown>[];
  expect(Object.hasOwn(prototype[0]!, '__proto__')).toBe(true); expect(({} as any).polluted).toBeUndefined();
  expect(previewImport(table, { ...json([{ ...prototype[0], amount: '1' }]), mapping: Object.fromEntries([['constructor', 'body'], ['__proto__', '']]) }).samples[0]!.values).toEqual({ body: 'text', amount: '1' });
});

test('review bounds source bytes, nesting, records, samples and error evidence', () => {
  const input = json(Array.from({ length: 130 }, (_, index) => index % 5 === 0 ? { body: 'text', amount: '1' } : { body: 'missing amount' }));
  const result = previewImport(table, input); expect(result.valid).toBe(26); expect(result.invalid).toBe(104);
  expect(result.samples).toHaveLength(20); expect(result.errors).toHaveLength(100); expect(result.errorsTruncated).toBe(true);
  expect(() => previewImport(table, json(Array.from({ length: 1001 }, () => ({}))))).toThrow('1000');
  expect(() => previewImport(table, json([{ body: 'é'.repeat(140000) }]))).toThrow('256 KiB');
  expect(() => parseImportJson('['.repeat(22) + '0' + ']'.repeat(22))).toThrow('nesting');
  const columns = Array.from({ length: 5 }, (_, i) => ({ name: 'text' + i, type: 'text' as const, nullable: false }));
  const hugeRow = Object.fromEntries(columns.map(column => [column.name, 'x'.repeat(16384)]));
  expect(previewImport({ ...table, definition: { ...table.definition, columns } }, json([hugeRow])).errors[0]!.code).toBe('row_too_large');
});

test('review does not claim to validate native uniqueness, checks or policy authority', () => {
  const constrained: DataTable = { ...table, definition: { ...table.definition, primaryKey: 'body', constraints: [
    { id: table.id, name: 'positive', kind: 'check', columns: ['amount'], check: { column: 'amount', operator: 'gte', value: '1' } },
  ] } };
  const input = { ...json([{ body: 'same', amount: '0' }, { body: 'same', amount: '0' }]), conflict: 'update' as const };
  expect(previewImport(constrained, input)).toMatchObject({ validation: 'structure', valid: 2, invalid: 0 });
  expect(() => previewImport(table, input)).toThrow('primary key');
});

test('native import execution is not accepted by ordinary account or signed data request contracts', () => {
  const command = parseComponent('DataImportExecution', { kind: 'rows.import.apply', commandId: table.id, tableId: table.id, revision: table.revision,
    input: json([{ body: 'test', amount: '1' }]), access: { mode: 'policy-preview' } });
  expect(() => parseComponent('AccountDataRequest', command)).toThrow();
  expect(() => parseComponent('DataRequest', { scope: { orgId: table.id, projectId: table.id, environmentId: table.id }, bindingId: table.id, command })).toThrow();
});
