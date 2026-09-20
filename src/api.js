async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed'), data);
  return data;
}

async function text(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(path);
  return response.text();
}

export async function importFixtureSet() {
  const files = [
    '/postgres-orders-baseline.json',
    '/postgres-orders-candidate-swap.json',
    '/spark-events-baseline.json',
    '/spark-events-candidate-shuffle.json',
    '/postgres-union-baseline.json',
    '/postgres-union-candidate-swap.json'
  ];
  const items = await Promise.all(files.map(async (file) => JSON.parse(await text(file))));
  return request('/imports', { method: 'POST', body: { items } });
}

export const api = {
  health: () => request('/health'),
  rules: () => request('/rules'),
  plans: () => request('/plans'),
  baselines: () => request('/baselines'),
  comparisons: () => request('/comparisons'),
  comparison: (id) => request(`/comparisons/${id}`),
  normalize: (sourceHashes, ruleVersion) => request('/normalizations', { method: 'POST', body: { sourceHashes, ruleVersion } }),
  publishBaseline: (normalizedHash, freeze = false) => request('/baselines', { method: 'POST', body: { normalizedHash, freeze } }),
  retainCandidate: (normalizedHash) => request('/candidates/retain', { method: 'POST', body: { normalizedHash, retained: true } }),
  compare: (baselineHash, candidateHash, statsConfig, ruleVersion) => request('/comparisons', {
    method: 'POST',
    body: { baselineHash, candidateHash, statsConfig, ruleVersion }
  }),
  annotate: (comparisonId, payload) => request(`/comparisons/${comparisonId}/annotations`, { method: 'POST', body: payload }),
  previewUpgrade: () => request('/rule-upgrades/preview', { method: 'POST', body: { toVersion: '2026-09-22.v2' } }),
  applyUpgrade: (sourceHashes) => request('/rule-upgrades/apply', { method: 'POST', body: { sourceHashes, toVersion: '2026-09-22.v2' } })
};
