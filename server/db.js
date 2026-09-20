import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalHash } from '../shared/hash.js';
import { CURRENT_RULE_VERSION, RULE_PACKS } from '../shared/rules.js';

export function openDatabase(path = process.env.PLAN_DIFF_DB || '.data/plans.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_plans (
      source_hash TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      format TEXT,
      query_fingerprint TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      label TEXT
    );
    CREATE TABLE IF NOT EXISTS normalized_plans (
      normalized_hash TEXT PRIMARY KEY,
      source_hash TEXT NOT NULL REFERENCES raw_plans(source_hash),
      rule_version TEXT NOT NULL,
      parser_version TEXT,
      query_fingerprint TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_hash, rule_version)
    );
    CREATE TABLE IF NOT EXISTS baselines (
      baseline_id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_fingerprint TEXT NOT NULL,
      normalized_hash TEXT NOT NULL REFERENCES normalized_plans(normalized_hash),
      revision INTEGER NOT NULL,
      frozen INTEGER NOT NULL DEFAULT 0,
      published_at TEXT NOT NULL DEFAULT (datetime('now')),
      label TEXT,
      UNIQUE(query_fingerprint, revision)
    );
    CREATE TABLE IF NOT EXISTS candidates (
      candidate_id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_fingerprint TEXT NOT NULL,
      normalized_hash TEXT NOT NULL REFERENCES normalized_plans(normalized_hash),
      retained INTEGER NOT NULL DEFAULT 1,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS comparisons (
      comparison_id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_fingerprint TEXT NOT NULL,
      baseline_id INTEGER REFERENCES baselines(baseline_id),
      baseline_normalized_hash TEXT NOT NULL,
      candidate_normalized_hash TEXT NOT NULL,
      rule_version TEXT NOT NULL,
      stats_config_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(baseline_normalized_hash, candidate_normalized_hash, rule_version, stats_config_json)
    );
    CREATE TABLE IF NOT EXISTS annotations (
      annotation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      comparison_id INTEGER NOT NULL REFERENCES comparisons(comparison_id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('explained', 'accepted', 'rejected', 'needs_review')),
      note TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(comparison_id, node_id)
    );
    CREATE TABLE IF NOT EXISTS rule_packs (
      version TEXT PRIMARY KEY,
      pack_json TEXT NOT NULL
    );
  `);
  const insertRule = db.prepare('INSERT OR IGNORE INTO rule_packs(version, pack_json) VALUES (?, ?)');
  for (const pack of Object.values(RULE_PACKS)) insertRule.run(pack.version, JSON.stringify(pack));
}

export function withTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function currentRuleVersion() {
  return CURRENT_RULE_VERSION;
}

export function planKeyHash(payloadText) {
  return canonicalHash(payloadText);
}
