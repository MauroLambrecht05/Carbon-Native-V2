#!/usr/bin/env bun

export {};

const host = process.env.HEALTHCHECK_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.HEALTH_PORT ?? 3_000);

try {
  const response = await fetch(`http://${host}:${port}/health/ready`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) process.exit(1);
} catch {
  process.exit(1);
}
