import { HttpDataClient, HttpImportClient } from '@carbon/data';
import { serviceAssertionIssuerFromEnv } from './service-assertion-signing.ts';

export function dataClientFromEnv(env: NodeJS.ProcessEnv = process.env): HttpDataClient | undefined {
  if (!env.CARBON_DATA_DATABASE_ORIGIN) return undefined;
  return new HttpDataClient(env.CARBON_DATA_DATABASE_ORIGIN, serviceAssertionIssuerFromEnv(env));
}

export function importClientFromEnv(env: NodeJS.ProcessEnv = process.env): HttpImportClient | undefined {
  if (!env.CARBON_DATA_IMPORTS || env.CARBON_DATA_IMPORTS === 'disabled') return undefined;
  if (env.CARBON_DATA_IMPORTS !== 'enabled') throw new Error('CARBON_DATA_IMPORTS must be enabled or disabled');
  if (!env.CARBON_DATA_DATABASE_ORIGIN) throw new Error('Durable imports require CARBON_DATA_DATABASE_ORIGIN');
  return new HttpImportClient(env.CARBON_DATA_DATABASE_ORIGIN, serviceAssertionIssuerFromEnv(env));
}
