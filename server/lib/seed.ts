import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CURRENT_RULE_VERSION, INITIAL_RULE_VERSION } from '../../shared/rules.ts';
import { listPlans } from '../db/repository.ts';
import { comparePlans, importPlans, normalizePlans, publishCurrentBaseline } from './service.ts';

export function seedDemoDatabase(database: DatabaseSync, fixtureDirectory: string): { seeded: boolean } {
  if (listPlans(database).length > 0) return { seeded: false };
  const files = readdirSync(fixtureDirectory).filter((file) => file.endsWith('.json')).sort();
  const payloads = files.map((file) => JSON.parse(readFileSync(join(fixtureDirectory, file), 'utf8')));
  importPlans(database, payloads);
  const plans = listPlans(database);
  const byVendor = new Map<string, string[]>();
  for (const plan of plans) {
    const list = byVendor.get(plan.vendor) ?? [];
    list.push(plan.id);
    byVendor.set(plan.vendor, list);
  }
  const pg = byVendor.get('postgresql') ?? [];
  const mysql = byVendor.get('mysql') ?? [];
  if (pg.length >= 4) {
    publishCurrentBaseline(database, pg[0], CURRENT_RULE_VERSION);
    comparePlans(database, { baselinePlanId: pg[0], candidatePlanId: pg[1], ruleVersion: CURRENT_RULE_VERSION });
    comparePlans(database, { baselinePlanId: pg[0], candidatePlanId: pg[2], ruleVersion: CURRENT_RULE_VERSION });
    comparePlans(database, { baselinePlanId: pg[0], candidatePlanId: pg[3], ruleVersion: CURRENT_RULE_VERSION });
    normalizePlans(database, [pg[0], pg[1]], INITIAL_RULE_VERSION);
    comparePlans(database, { baselinePlanId: pg[0], candidatePlanId: pg[1], ruleVersion: INITIAL_RULE_VERSION });
  }
  if (mysql.length >= 2) {
    publishCurrentBaseline(database, mysql[0], CURRENT_RULE_VERSION);
    comparePlans(database, { baselinePlanId: mysql[0], candidatePlanId: mysql[1], ruleVersion: CURRENT_RULE_VERSION });
  }
  return { seeded: true };
}
