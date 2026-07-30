import { ComparisonEntry, Hotspot, ProfileComparison, ProfileSession } from './model';

function hotspotKey(hotspot: Hotspot): string {
  return `${hotspot.name}\n${hotspot.location?.file ?? ''}`;
}

export function compareProfiles(baseline: ProfileSession, current: ProfileSession): ProfileComparison {
  if (baseline.sampleType !== current.sampleType || baseline.sampleUnit !== current.sampleUnit) {
    throw new Error(
      `Cannot compare ${baseline.sampleType} (${baseline.sampleUnit}) with ${current.sampleType} (${current.sampleUnit})`
    );
  }
  if (baseline.target && current.target && baseline.target !== current.target) {
    throw new Error(`Cannot compare different targets: ${baseline.target} and ${current.target}`);
  }
  if (
    /^alloc_/.test(current.sampleType)
    && (baseline.captureMode !== 'delta' || current.captureMode !== 'delta')
  ) {
    throw new Error(
      'Cumulative allocation profiles are not a reliable before/after benchmark. Use allocs/op and B/op benchmark results.'
    );
  }
  if (baseline.scenarioId && current.scenarioId && baseline.scenarioId !== current.scenarioId) {
    throw new Error('Cannot compare captures from different performance scenarios');
  }
  if (
    baseline.captureDurationMs
    && current.captureDurationMs
    && baseline.captureDurationMs !== current.captureDurationMs
  ) {
    throw new Error(
      `Cannot compare capture durations of ${baseline.captureDurationMs / 1000}s and ${current.captureDurationMs / 1000}s`
    );
  }
  const warnings: string[] = [];
  if (!baseline.target || !current.target) {
    warnings.push('Target identity is missing; confirm both profiles came from the same program.');
  }
  if (current.sampleType === 'cpu' && (!baseline.captureDurationMs || !current.captureDurationMs)) {
    warnings.push('CPU capture duration is missing; raw totals are only meaningful when durations and workload match.');
  }
  if (/^inuse_/.test(current.sampleType)) {
    warnings.push('Heap totals are comparable only after GC under the same workload and process lifecycle.');
  }

  const before = new Map(baseline.hotspots.map((hotspot) => [hotspotKey(hotspot), hotspot]));
  const after = new Map(current.hotspots.map((hotspot) => [hotspotKey(hotspot), hotspot]));
  const entries: ComparisonEntry[] = [];

  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const baselineHotspot = before.get(key);
    const currentHotspot = after.get(key);
    const beforeValue = baselineHotspot?.cumulative ?? 0;
    const afterValue = currentHotspot?.cumulative ?? 0;
    const delta = afterValue - beforeValue;
    entries.push({
      key,
      name: currentHotspot?.name ?? baselineHotspot?.name ?? key,
      before: beforeValue,
      after: afterValue,
      delta,
      deltaPercent: beforeValue === 0 ? undefined : delta / beforeValue * 100,
      location: currentHotspot?.location ?? baselineHotspot?.location
    });
  }

  entries.sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));
  const totalDelta = current.total - baseline.total;
  return {
    baseline,
    current,
    totalDelta,
    totalDeltaPercent: baseline.total === 0 ? undefined : totalDelta / baseline.total * 100,
    warnings,
    entries
  };
}
