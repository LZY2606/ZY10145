import {
  applyRuleUpgrade,
  createComparison,
  getComparison,
  importPlans,
  listAnnotations,
  listBaselines,
  listComparisons,
  listNormalized,
  listRulePacks,
  normalizeStoredPlans,
  previewRuleUpgrade,
  publishBaseline,
  retainCandidate,
  setBaselineFrozen,
  upsertAnnotation
} from './services.js';

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function methodError() {
  const error = new Error('Method not allowed');
  error.status = 405;
  return error;
}

export function createApiMiddleware(db) {
  return async function api(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      let body = {};
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await readJson(req);
        } catch (error) {
          return send(res, 400, { error: 'INVALID_JSON', message: error.message });
        }
      }
      let match;
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/rules') return send(res, 200, { rules: listRulePacks() });
      if (req.method === 'GET' && url.pathname === '/plans') return send(res, 200, { plans: listNormalized(db) });
      if (req.method === 'GET' && url.pathname === '/baselines') return send(res, 200, { baselines: listBaselines(db) });
      if (req.method === 'GET' && url.pathname === '/comparisons') return send(res, 200, { comparisons: listComparisons(db) });
      if (req.method === 'POST' && url.pathname === '/imports') {
        return send(res, 201, { imported: importPlans(db, body.items || [body.plan].filter(Boolean)) });
      }
      if (req.method === 'POST' && url.pathname === '/normalizations') {
        return send(res, 201, { normalized: normalizeStoredPlans(db, body.sourceHashes, body.ruleVersion) });
      }
      if (req.method === 'POST' && url.pathname === '/baselines') {
        return send(res, 201, { baseline: publishBaseline(db, body.normalizedHash, body) });
      }
      if ((match = url.pathname.match(/^\/baselines\/(\d+)\/freeze$/))) {
        if (req.method !== 'POST') throw methodError();
        return send(res, 200, { baseline: setBaselineFrozen(db, Number(match[1]), true) });
      }
      if ((match = url.pathname.match(/^\/baselines\/(\d+)\/unfreeze$/))) {
        if (req.method !== 'POST') throw methodError();
        return send(res, 200, { baseline: setBaselineFrozen(db, Number(match[1]), false) });
      }
      if (req.method === 'POST' && url.pathname === '/candidates/retain') {
        return send(res, 201, { candidate: retainCandidate(db, body.normalizedHash, body.retained ?? true, body.label) });
      }
      if (req.method === 'POST' && url.pathname === '/comparisons') {
        return send(res, 201, { comparison: createComparison(db, body.baselineHash, body.candidateHash, body.statsConfig, body.ruleVersion) });
      }
      if ((match = url.pathname.match(/^\/comparisons\/(\d+)$/))) {
        if (req.method !== 'GET') throw methodError();
        const comparison = getComparison(db, Number(match[1]));
        if (!comparison) return send(res, 404, { error: 'NOT_FOUND' });
        return send(res, 200, { comparison, annotations: listAnnotations(db, Number(match[1])) });
      }
      if (req.method === 'POST' && url.pathname === '/rule-upgrades/preview') {
        return send(res, 200, { preview: previewRuleUpgrade(db, body.toVersion) });
      }
      if (req.method === 'POST' && url.pathname === '/rule-upgrades/apply') {
        return send(res, 200, { normalized: applyRuleUpgrade(db, body.sourceHashes, body.toVersion) });
      }
      if ((match = url.pathname.match(/^\/comparisons\/(\d+)\/annotations$/))) {
        const comparisonId = Number(match[1]);
        if (req.method === 'GET') return send(res, 200, { annotations: listAnnotations(db, comparisonId) });
        if (req.method !== 'POST') throw methodError();
        return send(res, 201, {
          annotation: upsertAnnotation(db, comparisonId, body.nodeId, body.status, body.note || '', body.expectedVersion ?? null)
        });
      }
      return send(res, 404, { error: 'NOT_FOUND', path: url.pathname });
    } catch (error) {
      return send(res, error.status || 500, {
        error: error.status ? error.message : 'INTERNAL_ERROR',
        details: error.details || null,
        conflict: error.conflict || null
      });
    }
  };
}
