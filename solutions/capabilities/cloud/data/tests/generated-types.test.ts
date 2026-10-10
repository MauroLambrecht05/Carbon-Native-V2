import { expect, test } from 'bun:test';
import ts from 'typescript';
import { generatedTypes } from '../domain/GeneratedTypes.ts';
import type { DataTable } from '@carbon/contracts/platform';

const table: DataTable = { id: '11111111-1111-4111-8111-111111111111', revision: '7', definition: {
  name: 'class', policies: { enabled: false, rules: [] }, columns: [
    { name: 'default', type: 'text', nullable: false }, { name: 'integer', type: 'integer', nullable: false },
    { name: 'decimal', type: 'decimal', nullable: false }, { name: 'boolean', type: 'boolean', nullable: false },
    { name: 'timestamp', type: 'timestamp', nullable: false, default: { kind: 'now' } },
    { name: 'uuid', type: 'uuid', nullable: false, default: { kind: 'uuid' } },
    { name: 'json', type: 'json', nullable: true }, { name: 'jsonb', type: 'jsonb', nullable: true },
    { name: 'texts', type: 'text[]', nullable: true }, { name: 'integers', type: 'integer[]', nullable: true },
    { name: 'constructor', type: 'text', nullable: false, default: { kind: 'literal', value: 'private default */\nthrow new Error("injection");' } },
  ],
} };

test('generated table types compile with exact wire values, required fields, defaults and projections', () => {
  const artifact = generatedTypes(table); expect(artifact.filename).toBe('class-7.ts');
  expect(artifact.text).not.toContain('private default'); expect(generatedTypes(table)).toEqual(artifact);
  const source = artifact.text + `
const insert: CarbonInsert = { default: 'text', integer: '9223372036854775807', decimal: '1.000000000000001', boolean: false };
const withNulls: CarbonInsert = { ...insert, json: null, texts: null, integers: ['9223372036854775807'] };
const update: CarbonUpdate = { default: 'edited', decimal: '0.01' };
const ownConstructor: CarbonInsert = { ...insert, constructor: 'ordinary column' };
// @ts-expect-error Explicit prototype-named values still use their declared type.
const badConstructor: CarbonInsert = { ...insert, constructor: 123 };
// @ts-expect-error Non-nullable defaulted fields cannot be assigned null.
const nullConstructor: CarbonInsert = { ...insert, constructor: null };
const projected: CarbonRow<'integer'> = { id: 'id', revision: '3', values: { integer: '1' } };
const metadataOnly: CarbonRow<never> = { id: 'id', revision: '3', values: {} };
// @ts-expect-error Integer transport values cannot be numbers.
const badInteger: CarbonUpdate = { integer: 9007199254740993 };
// @ts-expect-error Integer-array elements are exact strings too.
const badArray: CarbonUpdate = { integers: [1] };
// @ts-expect-error Decimal transport values cannot be numbers.
const badDecimal: CarbonUpdate = { decimal: 0.1 };
// @ts-expect-error Non-nullable columns cannot be assigned null.
const badNull: CarbonUpdate = { default: null };
// @ts-expect-error Required fields cannot be omitted from inserts.
const missing: CarbonInsert = {};
// @ts-expect-error Defaults do not make returned row values optional.
const returned: CarbonRowValues = insert;
// @ts-expect-error A selected projection does not contain omitted fields.
const unselected = projected.values.decimal;
// @ts-expect-error Unknown columns cannot be selected.
type UnknownColumn = CarbonRow<'missing'>;
`;
  const filename = '/carbon-generated-types-fixture.ts';
  const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options); const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, onError, shouldCreate) => name === filename ? ts.createSourceFile(name, source, language, true) : getSourceFile(name, language, onError, shouldCreate);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([filename], options, host));
  expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
});

test('generated source remains bounded for the maximum schema and excludes schema literals', () => {
  const large: DataTable = { ...table, definition: { name: 'x'.repeat(63), policies: { enabled: true, rules: [] },
    columns: Array.from({ length: 100 }, (_, i) => ({ name: 'c' + String(i).padStart(62, '0'), type: 'jsonb' as const, nullable: true })) } };
  const result = generatedTypes(large); expect(Buffer.byteLength(result.text)).toBeLessThan(65536);
  expect(result.text).not.toContain('policy');
  expect(() => generatedTypes({ ...table, definition: { ...table.definition, name: 'evil\ncode' } })).toThrow();
});
