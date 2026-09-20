import type {
  ComparisonOptions,
  NormalizedPlan,
  PerformanceStatus,
  PerformanceVerdict,
  RobustStats
} from '../../shared/model.ts';

export const DEFAULT_OPTIONS: ComparisonOptions = {
  minSamples: 5,
  trimFraction: 0.15,
  regressionThresholdRatio: 1.2,
  improvementThresholdRatio: 0.8,
  estimateDriftRatio: 0.25,
  bootstrapReplicates: 999,
  confidenceLevel: 0.95
};

export type SampleForStats = { status: 'completed' | 'timeout' | 'error'; elapsedMs: number | null };

function quantile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) return Number.NaN;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (sortedValues.length - 1) * ratio;
  const base = Math.floor(position);
  const remainder = position - base;
  return sortedValues[base] * (1 - remainder) + sortedValues[Math.min(base + 1, sortedValues.length - 1)] * remainder;
}

export function robustStats(samples: SampleForStats[], trimFraction = 0.15): RobustStats {
  const values = samples
    .filter((sample): sample is { status: 'completed'; elapsedMs: number | null } => sample.status === 'completed')
    .map((sample) => sample.elapsedMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (values.length === 0) {
    return { count: 0, medianMs: null, trimmedMeanMs: null, madMs: null, minMs: null, maxMs: null };
  }
  const median = quantile(values, 0.5);
  const absoluteDeviations = values.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  const trimCount = Math.floor(values.length * trimFraction);
  const trimmed = values.slice(trimCount, values.length - trimCount);
  return {
    count: values.length,
    medianMs: median,
    trimmedMeanMs: trimmed.length ? trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length : median,
    madMs: quantile(absoluteDeviations, 0.5),
    minMs: values[0],
    maxMs: values[values.length - 1]
  };
}

function seededPick(values: number[], seed: number, round: number): number {
  const x = Math.sin(seed * 9973 + round * 7919 + 17) * 10000;
  return values[Math.floor((x - Math.floor(x)) * values.length) % values.length];
}

function median(values: number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

export function bootstrapRatio(baseline: number[], candidate: number[], options: ComparisonOptions): [number, number] | null {
  if (baseline.length === 0 || candidate.length === 0 || median(baseline) === 0) return null;
  const ratios: number[] = [];
  for (let round = 0; round < options.bootstrapReplicates; round += 1) {
    const baselineSample = Array.from({ length: baseline.length }, (_, index) => seededPick(baseline, index + 1, round));
    const candidateSample = Array.from({ length: candidate.length }, (_, index) => seededPick(candidate, index + baseline.length + 11, round));
    const denominator = median(baselineSample);
    const value = median(candidateSample);
    if (denominator > 0) ratios.push(value / denominator);
  }
  ratios.sort((a, b) => a - b);
  const tail = (1 - options.confidenceLevel) / 2;
  return [quantile(ratios, tail), quantile(ratios, 1 - tail)];
}

export function elapsedSamples(samples: SampleForStats[]): number[] {
  return samples.flatMap((sample) => (sample.status === 'completed' && typeof sample.elapsedMs === 'number' ? [sample.elapsedMs] : []));
}

function stableParameterDigest(plan: NormalizedPlan): string {
  return JSON.stringify(plan.parameters, Object.keys(plan.parameters).sort());
}

export function environmentComparable(baseline: NormalizedPlan, candidate: NormalizedPlan): { comparable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (baseline.queryFingerprint !== candidate.queryFingerprint) reasons.push('query fingerprint differs');
  if (baseline.schemaDigest !== candidate.schemaDigest) reasons.push('schema digest differs');
  if (stableParameterDigest(baseline) !== stableParameterDigest(candidate)) reasons.push('runtime parameter environment differs');
  if (baseline.ruleVersion !== candidate.ruleVersion) reasons.push('normalization rule versions differ');
  return { comparable: reasons.length === 0, reasons };
}

export function hasMissingPlanFields(plan: NormalizedPlan): boolean {
  let missing = false;
  const visit = (node: NormalizedPlan['root']): void => {
    if (node.estimatedRows === null || node.estimatedCost === null || node.warnings.some((warning) => warning.code === 'missing_field')) missing = true;
    node.children.forEach((child) => visit(child.node));
  };
  visit(plan.root);
  return missing;
}

export function evaluatePerformance(
  baselinePlan: NormalizedPlan,
  candidatePlan: NormalizedPlan,
  baselineSamples: SampleForStats[],
  candidateSamples: SampleForStats[],
  suppliedOptions?: Partial<ComparisonOptions>
): {
  status: PerformanceStatus;
  verdict: PerformanceVerdict;
  baselineStats: RobustStats;
  candidateStats: RobustStats;
  medianRatio: number | null;
  confidenceInterval: [number, number] | null;
  reasons: string[];
  options: ComparisonOptions;
} {
  const options = { ...DEFAULT_OPTIONS, ...suppliedOptions };
  const environment = environmentComparable(baselinePlan, candidatePlan);
  const baselineStats = robustStats(baselineSamples, options.trimFraction);
  const candidateStats = robustStats(candidateSamples, options.trimFraction);
  const baselineValues = elapsedSamples(baselineSamples);
  const candidateValues = elapsedSamples(candidateSamples);
  let status: PerformanceStatus = 'comparable';
  let verdict: PerformanceVerdict = 'unchanged';
  const reasons = [...environment.reasons];

  if (!environment.comparable) {
    status = 'incomparable_environment';
  } else if ([...baselineSamples, ...candidateSamples].some((sample) => sample.status === 'timeout')) {
    status = 'timeout';
    reasons.push('at least one timeout sample exists');
  } else if (baselineValues.length < options.minSamples || candidateValues.length < options.minSamples) {
    status = 'insufficient_samples';
    reasons.push(`each plan requires at least ${options.minSamples} completed timed samples`);
  } else if (hasMissingPlanFields(baselinePlan) || hasMissingPlanFields(candidatePlan)) {
    status = 'missing_fields';
    reasons.push('at least one plan node has missing estimate or decision fields');
  }

  const baselineMedian = baselineStats.medianMs;
  const candidateMedian = candidateStats.medianMs;
  const medianRatio = baselineMedian && candidateMedian ? candidateMedian / baselineMedian : null;
  const confidenceInterval = status === 'comparable' ? bootstrapRatio(baselineValues, candidateValues, options) : null;

  if (status === 'comparable' && confidenceInterval) {
    if (confidenceInterval[0] > options.regressionThresholdRatio) verdict = 'regression';
    else if (confidenceInterval[1] < options.improvementThresholdRatio) verdict = 'improvement';
    else verdict = 'indeterminate';
  } else if (status !== 'comparable') {
    verdict = 'indeterminate';
  }

  return { status, verdict, baselineStats, candidateStats, medianRatio, confidenceInterval, reasons, options };
}
