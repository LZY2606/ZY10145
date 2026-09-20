import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { CURRENT_RULE_VERSION, RULES } from '../shared/rules.ts';
import { ConflictError, listAnnotations, listBaselines } from './db/repository.ts';
import {
  annotateNode,
  comparePlans,
  freezeBaseline,
  getPlanBundle,
  importPlans,
  normalizePlans,
  previewRuleUpgrade,
  publishCurrentBaseline,
  publishCurrentBaselines,
  storeState,
  upgradeRules
} from './lib/service.ts';

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

export function createApiHandler(database: DatabaseSync) {
  return async function apiHandler(request: IncomingMessage, response: ServerResponse, next?: () => void): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/')) {
      next?.();
      return;
    }
    try {
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const state = storeState(database);
        send(response, 200, { ...state, baselines: listBaselines(database), rules: RULES });
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/comparisons/') && url.pathname.endsWith('/annotations')) {
        const comparisonId = url.pathname.split('/')[3];
        send(response, 200, { annotations: listAnnotations(database, comparisonId) });
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/plans/')) {
        const parts = url.pathname.split('/');
        const planId = decodeURIComponent(parts[3] ?? '');
        const ruleVersion = url.searchParams.get('ruleVersion') ?? CURRENT_RULE_VERSION;
        if (planId) {
          send(response, 200, getPlanBundle(database, planId, ruleVersion));
          return;
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/plans/import') {
        const body = await readJson(request);
        const payloads = Array.isArray(body) ? body : Array.isArray((body as { plans?: unknown[] }).plans) ? (body as { plans: unknown[] }).plans : [body];
        send(response, 200, importPlans(database, payloads));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/plans/normalize') {
        const body = (await readJson(request)) as { planIds: string[]; ruleVersion: string };
        send(response, 200, normalizePlans(database, body.planIds, body.ruleVersion));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/compare') {
        const body = (await readJson(request)) as Parameters<typeof comparePlans>[1];
        send(response, 200, comparePlans(database, body));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/baselines/publish') {
        const body = (await readJson(request)) as { planId: string; ruleVersion: string };
        send(response, 200, publishCurrentBaseline(database, body.planId, body.ruleVersion));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/baselines/publish-batch') {
        const body = (await readJson(request)) as { requests: Array<{ planId: string; ruleVersion: string }> };
        send(response, 200, { results: publishCurrentBaselines(database, body.requests) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/baselines/freeze') {
        const body = (await readJson(request)) as { planId: string; ruleVersion: string; frozen: boolean };
        send(response, 200, freezeBaseline(database, body.planId, body.ruleVersion, body.frozen));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/annotations') {
        const body = (await readJson(request)) as Parameters<typeof annotateNode>[1];
        send(response, 200, { annotation: annotateNode(database, body) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/rules/upgrade-preview') {
        const body = (await readJson(request)) as { fromRuleVersion: string; toRuleVersion: string };
        send(response, 200, previewRuleUpgrade(database, body.fromRuleVersion, body.toRuleVersion));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/rules/upgrade') {
        const body = (await readJson(request)) as { fromRuleVersion: string; toRuleVersion: string };
        send(response, 200, upgradeRules(database, body.fromRuleVersion, body.toRuleVersion));
        return;
      }
      send(response, 404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof ConflictError) {
        send(response, 409, { error: error.message, stored: error.stored, nodeDiff: error.nodeDiff });
        return;
      }
      send(response, 400, { error: error instanceof Error ? error.message : 'Unknown request error' });
    }
  };
}
