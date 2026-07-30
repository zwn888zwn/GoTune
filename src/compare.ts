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
    entries
  };
}
