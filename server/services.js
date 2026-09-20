import { canonicalHash } from '../shared/hash.js';
import { parsePlanJson } from '../shared/parse.js';
import { normalizePlan } from '../shared/normalize.js';
import { comparePlans } from '../shared/compare.js';
import { CURRENT_RULE_VERSION, getRulePack, RULE_PACKS } from '../shared/rules.js';
import { DEFAULT_STATS_CONFIG } from '../shared/stats.js';
import { withTransaction } from './db.js';

function parseJsonBuffer(buffer) {
  const text = buffer.toString('utf8');
  return JSON.parse(text);
}

export function importPlans(db, items) {
  const parsed = items.map((item) => {
    const payloadText = typeof item === 'string' || Buffer.isBuffer(item) ? item.toString('utf8') : JSON.stringify(item);
    const sourceHash = canonicalHash(payloadText);
    const result = parsePlanJson(payloadText, sourceHash);
    return { payloadText, sourceHash, ...result };
  });
  const failures = parsed.filter((item) => !item.plan);
  if (failures.length) {
    const error = new Error('All plans in a batch must parse before import.');
    error.status = 422;
    error.details = failures.map((item) => item.diagnostics);
    throw error;
  }
  return withTransaction(db, () => {
    const statement = db.prepare(`
      INSERT INTO raw_plans(source_hash, payload_json, format, query_fingerprint, label)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_hash) DO NOTHING
    `);
    return parsed.map((item) => {
      const info = statement.run(item.sourceHash, item.payloadText, item.plan.format, item.plan.queryFingerprint, item.label || null);
      return {
        sourceHash: item.sourceHash,
        created: Boolean(info.changes),
        format: item.plan.format,
        queryFingerprint: item.plan.queryFingerprint,
        diagnostics: item.diagnostics
      };
    });
  });
}

export function normalizeStoredPlans(db, sourceHashes = [], ruleVersion = CURRENT_RULE_VERSION) {
  getRulePack(ruleVersion);
  const select = db.prepare('SELECT * FROM raw_plans WHERE source_hash = ?');
  const rows = sourceHashes.map((hash) => ({ hash, row: select.get(hash) }));
  const missing = rows.filter((item) => !item.row);
  if (missing.length) {
    const error = new Error('Unknown source hashes; normalization batch rolled back.');
    error.status = 404;
    error.details = missing.map((item) => item.hash);
    throw error;
  }
  const prepared = rows.map(({ hash, row }) => {
    const { plan, diagnostics } = parsePlanJson(row.payload_json, hash);
    const normalized = normalizePlan(plan, ruleVersion, diagnostics);
    return { row, normalized, diagnostics };
  });
  return withTransaction(db, () => {
    const statement = db.prepare(`
      INSERT INTO normalized_plans(
        normalized_hash, source_hash, rule_version, parser_version,
        query_fingerprint, plan_json, diagnostics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_hash, rule_version) DO UPDATE SET
        normalized_hash = excluded.normalized_hash,
        parser_version = excluded.parser_version,
        query_fingerprint = excluded.query_fingerprint,
        plan_json = excluded.plan_json,
        diagnostics_json = excluded.diagnostics_json
    `);
    return prepared.map(({ normalized, diagnostics }) => {
      statement.run(
        normalized.normalizedHash,
        normalized.sourceHash,
        normalized.ruleVersion,
        normalized.parserVersion,
        normalized.queryFingerprint,
        JSON.stringify(normalized),
        JSON.stringify(diagnostics)
      );
      return {
        sourceHash: normalized.sourceHash,
        normalizedHash: normalized.normalizedHash,
        ruleVersion: normalized.ruleVersion,
        logicalFingerprint: normalized.logicalFingerprint,
        physicalFingerprint: normalized.physicalFingerprint,
        diagnostics
      };
    });
  });
}

export function listNormalized(db) {
  return db.prepare(`
    SELECT normalized_hash, source_hash, rule_version, query_fingerprint, parser_version, plan_json, diagnostics_json
    FROM normalized_plans ORDER BY created_at DESC
  `).all().map((row) => ({
    ...row,
    plan: JSON.parse(row.plan_json),
    diagnostics: JSON.parse(row.diagnostics_json)
  }));
}

export function getNormalized(db, normalizedHash) {
  const row = db.prepare('SELECT * FROM normalized_plans WHERE normalized_hash = ?').get(normalizedHash);
  if (!row) return null;
  return { ...row, plan: JSON.parse(row.plan_json), diagnostics: JSON.parse(row.diagnostics_json) };
}

export function publishBaseline(db, normalizedHash, { label = null, freeze = false } = {}) {
  const plan = getNormalized(db, normalizedHash);
  if (!plan) {
    const error = new Error('Unknown normalized plan.');
    error.status = 404;
    throw error;
  }
  return withTransaction(db, () => {
    const frozen = db.prepare('SELECT baseline_id, revision FROM baselines WHERE query_fingerprint = ? AND frozen = 1 ORDER BY revision DESC LIMIT 1')
      .get(plan.query_fingerprint);
    if (frozen && frozen.baseline_id) {
      const error = new Error('A frozen baseline already exists for this fingerprint. Unfreeze before publishing another revision.');
      error.status = 409;
      error.baselineId = frozen.baseline_id;
      throw error;
    }
    const revisionRow = db.prepare('SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM baselines WHERE query_fingerprint = ?')
      .get(plan.query_fingerprint);
    const info = db.prepare(`
      INSERT INTO baselines(query_fingerprint, normalized_hash, revision, frozen, label)
      VALUES (?, ?, ?, ?, ?)
    `).run(plan.query_fingerprint, normalizedHash, revisionRow.revision, freeze ? 1 : 0, label);
    return db.prepare('SELECT * FROM baselines WHERE baseline_id = ?').get(Number(info.lastInsertRowid));
  });
}

export function setBaselineFrozen(db, baselineId, frozen) {
  return withTransaction(db, () => {
    const info = db.prepare('UPDATE baselines SET frozen = ? WHERE baseline_id = ?').run(frozen ? 1 : 0, baselineId);
    if (!info.changes) {
      const error = new Error('Unknown baseline.');
      error.status = 404;
      throw error;
    }
    return db.prepare('SELECT * FROM baselines WHERE baseline_id = ?').get(baselineId);
  });
}

export function listBaselines(db) {
  return db.prepare('SELECT * FROM baselines ORDER BY query_fingerprint, revision DESC').all();
}

export function retainCandidate(db, normalizedHash, retained, label = null) {
  const plan = getNormalized(db, normalizedHash);
  if (!plan) {
    const error = new Error('Unknown normalized plan.');
    error.status = 404;
    throw error;
  }
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO candidates(query_fingerprint, normalized_hash, retained, label)
      VALUES (?, ?, ?, ?)
    `).run(plan.query_fingerprint, normalizedHash, retained ? 1 : 0, label);
    return { normalizedHash, retained: Boolean(retained), label };
  });
}

export function createComparison(db, baselineHash, candidateHash, statsConfig = {}, ruleVersion = CURRENT_RULE_VERSION) {
  const baseline = getNormalized(db, baselineHash);
  const candidate = getNormalized(db, candidateHash);
  if (!baseline || !candidate) {
    const error = new Error('Unknown baseline or candidate normalized hash.');
    error.status = 404;
    throw error;
  }
  if (baseline.rule_version !== ruleVersion || candidate.rule_version !== ruleVersion) {
    const error = new Error('Both sides must use the requested rule version. Re-normalize before comparison.');
    error.status = 409;
    throw error;
  }
  const config = { ...DEFAULT_STATS_CONFIG, ...statsConfig };
  const configJson = JSON.stringify(config);
  const result = comparePlans(baseline.plan, candidate.plan, config);
  const resultJson = JSON.stringify(result);
  const baselineId = getActiveBaselineId(db, baseline.query_fingerprint, baselineHash);
  const info = db.prepare(`
    INSERT INTO comparisons(
      query_fingerprint, baseline_id, baseline_normalized_hash,
      candidate_normalized_hash, rule_version, stats_config_json, result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(baseline_normalized_hash, candidate_normalized_hash, rule_version, stats_config_json)
    DO UPDATE SET result_json = excluded.result_json, baseline_id = excluded.baseline_id, created_at = datetime('now')
  `).run(baseline.query_fingerprint, baselineId, baselineHash, candidateHash, ruleVersion, configJson, resultJson);
  return getComparison(db, Number(info.lastInsertRowid));
}

function getActiveBaselineId(db, fingerprint, normalizedHash) {
  return db.prepare(`
    SELECT baseline_id FROM baselines
    WHERE query_fingerprint = ? AND normalized_hash = ?
    ORDER BY frozen DESC, revision DESC LIMIT 1
  `).get(fingerprint, normalizedHash)?.baselineId || null;
}

export function getComparison(db, comparisonId) {
  const row = db.prepare('SELECT * FROM comparisons WHERE comparison_id = ?').get(comparisonId);
  if (!row) return null;
  return { ...row, result: JSON.parse(row.result_json), statsConfig: JSON.parse(row.stats_config_json) };
}

export function listComparisons(db) {
  return db.prepare('SELECT comparison_id, query_fingerprint, baseline_normalized_hash, candidate_normalized_hash, rule_version, created_at FROM comparisons ORDER BY comparison_id DESC').all();
}

export function upsertAnnotation(db, comparisonId, nodeId, status, note, expectedVersion = null) {
  return withTransaction(db, () => {
    const comparison = db.prepare('SELECT comparison_id FROM comparisons WHERE comparison_id = ?').get(comparisonId);
    if (!comparison) {
      const error = new Error('Unknown comparison.');
      error.status = 404;
      throw error;
    }
    const existing = db.prepare('SELECT * FROM annotations WHERE comparison_id = ? AND node_id = ?').get(comparisonId, nodeId);
    if (existing && expectedVersion !== null && Number(expectedVersion) !== existing.version) {
      const error = new Error('Annotation was modified concurrently.');
      error.status = 409;
      error.conflict = {
        nodeId,
        expectedVersion: Number(expectedVersion),
        currentVersion: existing.version,
        current: annotationPayload(existing)
      };
      throw error;
    }
    if (existing) {
      db.prepare('UPDATE annotations SET status = ?, note = ?, version = version + 1, updated_at = datetime(\'now\') WHERE annotation_id = ?')
        .run(status, note, existing.annotation_id);
    } else {
      db.prepare('INSERT INTO annotations(comparison_id, node_id, status, note) VALUES (?, ?, ?, ?)')
        .run(comparisonId, nodeId, status, note);
    }
    const row = db.prepare('SELECT * FROM annotations WHERE comparison_id = ? AND node_id = ?').get(comparisonId, nodeId);
    return annotationPayload(row);
  });
}

function annotationPayload(row) {
  return {
    annotationId: row.annotation_id,
    comparisonId: row.comparison_id,
    nodeId: row.node_id,
    status: row.status,
    note: row.note,
    version: row.version,
    updatedAt: row.updated_at
  };
}

export function listAnnotations(db, comparisonId) {
  return db.prepare('SELECT * FROM annotations WHERE comparison_id = ? ORDER BY annotation_id').all(comparisonId).map(annotationPayload);
}

export function previewRuleUpgrade(db, toVersion = '2026-09-22.v2') {
  getRulePack(toVersion);
  const affected = [];
  const rows = db.prepare('SELECT * FROM normalized_plans').all();
  for (const row of rows) {
    const plan = JSON.parse(row.plan_json);
    const diagnostics = JSON.parse(row.diagnostics_json);
    const next = normalizePlan(plan, toVersion, diagnostics);
    if (next.logicalFingerprint !== plan.logicalFingerprint || next.physicalFingerprint !== plan.physicalFingerprint) {
      affected.push({
        sourceHash: row.source_hash,
        fromVersion: row.rule_version,
        toVersion,
        oldLogicalFingerprint: plan.logicalFingerprint,
        newLogicalFingerprint: next.logicalFingerprint,
        oldPhysicalFingerprint: plan.physicalFingerprint,
        newPhysicalFingerprint: next.physicalFingerprint
      });
    }
  }
  return { ruleVersion: toVersion, affected, recomputed: false, awaitingUserDecision: true };
}

export function applyRuleUpgrade(db, sourceHashes, toVersion = '2026-09-22.v2') {
  getRulePack(toVersion);
  const selected = new Set(sourceHashes || []);
  const rows = db.prepare('SELECT * FROM normalized_plans').all().filter((row) => !selected.size || selected.has(row.source_hash));
  return withTransaction(db, () => normalizeStoredRows(db, rows, toVersion));
}

function normalizeStoredRows(db, rows, ruleVersion) {
  return rows.map((row) => {
    const plan = JSON.parse(row.plan_json);
    const diagnostics = JSON.parse(row.diagnostics_json);
    const normalized = normalizePlan(plan, ruleVersion, diagnostics);
    db.prepare(`
      INSERT OR REPLACE INTO normalized_plans(
        normalized_hash, source_hash, rule_version, parser_version,
        query_fingerprint, plan_json, diagnostics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.normalizedHash,
      normalized.sourceHash,
      normalized.ruleVersion,
      normalized.parserVersion,
      normalized.queryFingerprint,
      JSON.stringify(normalized),
      JSON.stringify(diagnostics)
    );
    return { sourceHash: normalized.sourceHash, normalizedHash: normalized.normalizedHash, ruleVersion };
  });
}

export function listRulePacks() {
  return Object.values(RULE_PACKS);
}
