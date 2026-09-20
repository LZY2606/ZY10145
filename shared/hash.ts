import { createHash } from 'node:crypto';

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function shortHash(value: unknown): string {
  return sha256(value).slice(0, 12);
}

export function contentHash(value: unknown): string {
  return sha256(value);
}
