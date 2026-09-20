export const IR_MODEL_VERSION = 'ir-1.0';

export function createPlan({
  format,
  queryFingerprint,
  schema,
  statsVersion,
  parameters = {},
  environment = {},
  root,
  samples = [],
  sourceHash,
  capturedAt = null,
  parserVersion
}) {
  return {
    modelVersion: IR_MODEL_VERSION,
    format,
    queryFingerprint,
    schema: sanitizeSchema(schema),
    statsVersion,
    parameters,
    environment: sanitizeEnvironment(environment),
    root,
    samples,
    sourceHash,
    capturedAt,
    parserVersion
  };
}

export function createNode({
  kind,
  operator,
  relation = null,
  index = null,
  partition = null,
  estimates = {},
  details = {},
  children = [],
  roles = null,
  vendorPath = [],
  expressions = {},
  timingKey = null
}) {
  return {
    id: null,
    kind,
    operator,
    relation,
    index,
    partition,
    estimates: {
      rows: estimates.rows ?? null,
      width: estimates.width ?? null,
      cost: { startup: null, total: null, ...(estimates.cost || {}) }
    },
    details,
    expressions,
    roles,
    children,
    timingKey
  };
}

export function sanitizeSchema(schema = {}) {
  return {
    digest: schema.digest || null,
    tables: (schema.tables || []).map((table) => ({
      name: table.name,
      columns: table.columns || [],
      partitions: table.partitions || null
    }))
  };
}

export function sanitizeEnvironment(environment = {}) {
  return {
    vendor: environment.vendor || null,
    vendorVersion: environment.vendorVersion || null,
    database: environment.database || null,
    timezone: environment.timezone || null
  };
}

export function requiredNodeFields() {
  return ['kind', 'operator', 'estimates.rows'];
}
