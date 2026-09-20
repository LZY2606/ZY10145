import { canonicalHash } from './hash.js';
import { isPostgresPayload, parsePostgresPlan } from './parsers/postgres.js';
import { isSparkPayload, parseSparkPlan } from './parsers/spark.js';

export function parsePlanJson(json, sourceHash = canonicalHash(json)) {
  let payload;
  try {
    payload = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (error) {
    return { plan: null, diagnostics: [{ path: [], code: 'INVALID_JSON', message: error.message }] };
  }
  if (isPostgresPayload(payload)) return parsePostgresPlan(payload, sourceHash);
  if (isSparkPayload(payload)) return parseSparkPlan(payload, sourceHash);
  return {
    plan: null,
    diagnostics: [{ path: [], code: 'UNSUPPORTED_PLAN_FORMAT', message: 'Expected PostgreSQL EXPLAIN JSON or Spark physical plan JSON.' }]
  };
}
