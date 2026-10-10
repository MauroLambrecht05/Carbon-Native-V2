import { expect, test } from 'bun:test';
import { compileLegacyPolicy, InvalidRlsPolicyError, RlsPolicySnapshot } from '../infrastructure/services/RlsPolicyEngine.ts';

test('legacy policy syntax is explicit, bounded to supported forms and fail closed', () => {
  for (const expression of [undefined, '', 'TRUE', 'auth.orgId = record.orgId', 'unknown', 'record.is_public == true || true', 'true; SELECT 1']) {
    expect(() => compileLegacyPolicy(expression)).toThrow(InvalidRlsPolicyError);
  }
  expect(compileLegacyPolicy('auth.orgId == record.orgId')({ orgId: 'a', role: 'authenticated' }, { orgId: 'a' })).toBe(true);
  expect(compileLegacyPolicy('auth.orgId == record.orgId')({ orgId: 'a', role: 'authenticated' }, { orgId: 'b' })).toBe(false);
  expect(compileLegacyPolicy('auth.orgId == record.orgId')({ orgId: 'anon', role: 'anon' }, { orgId: 'anon' })).toBe(false);
  expect(compileLegacyPolicy('auth.userId == record.userId')({ orgId: 'a' }, {})).toBe(false);
  expect(compileLegacyPolicy('auth.userId == record.userId')({ orgId: 'a', userId: 'u' }, { userId: 'u' })).toBe(true);
  expect(compileLegacyPolicy('record.is_public == true')({ orgId: 'anon' }, { is_public: 'true' })).toBe(false);
  const allow = { id: 'p', name: 'Public', action: 'SELECT' as const, check: compileLegacyPolicy('true') };
  expect(new RlsPolicySnapshot(false, [allow], true).allows('SELECT', { orgId: 'anon' }, {})).toBe(false);
  expect(new RlsPolicySnapshot(true, [allow], false).allows('SELECT', { orgId: 'anon' }, {})).toBe(false);
  expect(new RlsPolicySnapshot(true, [], true).allows('SELECT', { orgId: 'anon' }, {})).toBe(false);
  expect(new RlsPolicySnapshot(true, [allow], true).allows('DELETE', { orgId: 'anon' }, {})).toBe(false);
});
