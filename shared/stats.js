export const DEFAULT_STATS_CONFIG = {
  minSamples: 3,
  medianRatioThreshold: 1.15,
  effectThreshold: 0.474,
  timeoutRateDeltaThreshold: 0.05,
  relativeDriftThreshold: 0.2
};

export function quantile(sortedValues, percentile) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const index = (sortedValues.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

export function summarize(samples, config = DEFAULT_STATS_CONFIG) {
  const all = (samples || []).map((sample) =>
    typeof sample === 'number' ? { durationMs: sample, timeout: false } : sample
  );
  const timedOut = all.filter((sample) => sample.timeout);
  const completed = all
    .filter((sample) => !sample.timeout && Number.isFinite(Number(sample.durationMs)))
    .map((sample) => Number(sample.durationMs))
    .sort((left, right) => left - right);
  const median = quantile(completed, 0.5);
  const q1 = quantile(completed, 0.25);
  const q3 = quantile(completed, 0.75);
  const deviations = completed.map((value) => Math.abs(value - median));
  const mad = quantile([...deviations].sort((left, right) => left - right), 0.5);
  return {
    total: all.length,
    completed: completed.length,
    timeouts: timedOut.length,
    timeoutRate: all.length ? timedOut.length / all.length : null,
    median,
    q1,
    q3,
    iqr: q1 !== null && q3 !== null ? q3 - q1 : null,
    mad,
    insufficient: completed.length < config.minSamples
  };
}

export function cliffsDelta(baselineValues, candidateValues) {
  if (!baselineValues.length || !candidateValues.length) return null;
  let greater = 0;
  let less = 0;
  const left = baselineValues.map((value) => typeof value === 'number' ? value : Number(value.durationMs));
  const right = candidateValues.map((value) => typeof value === 'number' ? value : Number(value.durationMs));
  for (const baseline of left) {
    for (const candidate of right) {
      if (candidate > baseline) greater += 1;
      if (candidate < baseline) less += 1;
    }
  }
  const pairs = left.length * right.length;
  return { delta: (greater - less) / pairs, probabilitySuperior: greater / pairs };
}

function completedDurations(samples) {
  return (samples || [])
    .filter((sample) => typeof sample === 'number' || (!sample.timeout && Number.isFinite(Number(sample.durationMs))))
    .map((sample) => Number(typeof sample === 'number' ? sample : sample.durationMs));
}

export function comparePerformance(baselineSamples, candidateSamples, suppliedConfig = {}) {
  const config = { ...DEFAULT_STATS_CONFIG, ...suppliedConfig };
  const baseline = summarize(baselineSamples, config);
  const candidate = summarize(candidateSamples, config);
  const states = [];
  const baselineValues = completedDurations(baselineSamples);
  const candidateValues = completedDurations(candidateSamples);

  if (!baseline.total || !candidate.total) states.push('SAMPLES_MISSING');
  if (baseline.insufficient || candidate.insufficient) states.push('INSUFFICIENT_SAMPLES');
  if (baseline.timeouts || candidate.timeouts) states.push('TIMEOUT_PRESENT');

  const ratio = baseline.median && candidate.median ? candidate.median / baseline.median : null;
  const effect = cliffsDelta(baselineValues, candidateValues);
  const timeoutRateDelta = baseline.timeoutRate !== null && candidate.timeoutRate !== null
    ? candidate.timeoutRate - baseline.timeoutRate
    : null;
  const robustSignal = ratio !== null && effect !== null
    ? Math.abs(ratio - 1) >= config.medianRatioThreshold - 1 && Math.abs(effect.delta) >= config.effectThreshold
    : false;
  const timeoutRegression = timeoutRateDelta !== null && timeoutRateDelta > config.timeoutRateDeltaThreshold;
  const timeoutImprovement = timeoutRateDelta !== null && timeoutRateDelta < -config.timeoutRateDeltaThreshold;

  let verdict = 'INCONCLUSIVE';
  if (!states.includes('SAMPLES_MISSING') && !states.includes('INSUFFICIENT_SAMPLES')) {
    if ((ratio > config.medianRatioThreshold && effect.delta >= config.effectThreshold) || timeoutRegression) {
      verdict = 'REGRESSION';
    } else if ((ratio < 1 / config.medianRatioThreshold && effect.delta <= -config.effectThreshold) || timeoutImprovement) {
      verdict = 'IMPROVEMENT';
    }
  }

  return {
    verdict,
    states,
    config,
    baseline,
    candidate,
    medianRatio: ratio,
    effect,
    timeoutRateDelta,
    robustSignal,
    decisionRule: 'Requires median ratio threshold and Cliff delta; timeout-rate changes use a separate robust signal. A single run is never sufficient.'
  };
}

export function nodeTimingSummary(samples, timingKey) {
  return summarize((samples || []).flatMap((sample) => {
    const value = sample.nodeTimings?.[timingKey];
    return value === undefined || sample.timeout
      ? []
      : [{ durationMs: value }];
  }), { minSamples: 1 });
}
