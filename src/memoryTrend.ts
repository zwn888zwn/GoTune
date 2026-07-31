import { isRuntimeHotspot } from './classify';
import { ProfileSession, SourceLocation } from './model';

export interface MemoryTrendEntry {
  key: string;
  name: string;
  values: number[];
  growth: number;
  consistentlyGrowing: boolean;
  location?: SourceLocation;
}

export interface MemoryTrend {
  sessions: ProfileSession[];
  totals: number[];
  totalGrowth: number;
  entries: MemoryTrendEntry[];
}

export function analyzeMemoryTrend(sessions: ProfileSession[]): MemoryTrend {
  if (sessions.length < 3) {
    throw new Error('Memory growth analysis requires at least three heap snapshots');
  }
  const sampleType = sessions[0].sampleType;
  const sampleUnit = sessions[0].sampleUnit;
  if (
    !/^inuse_(?:space|objects)$/.test(sampleType)
    || sessions.some((session) =>
      session.sampleType !== sampleType || session.sampleUnit !== sampleUnit
    )
  ) {
    throw new Error('Memory growth analysis requires matching inuse_space or inuse_objects heap snapshots');
  }

  const keys = new Set<string>();
  const bySession = sessions.map((session) => {
    const values = new Map<string, { name: string; value: number; location?: SourceLocation }>();
    for (const hotspot of session.hotspots.filter((candidate) => !isRuntimeHotspot(candidate))) {
      const key = `${hotspot.name}\n${hotspot.location?.file ?? ''}`;
      keys.add(key);
      values.set(key, {
        name: hotspot.name,
        value: hotspot.flat,
        location: hotspot.location
      });
    }
    return values;
  });

  const entries = [...keys].map((key) => {
    const samples = bySession.map((values) => values.get(key));
    const values = samples.map((sample) => sample?.value ?? 0);
    const growth = values.at(-1)! - values[0];
    return {
      key,
      name: samples.find(Boolean)?.name ?? key,
      values,
      growth,
      consistentlyGrowing: growth > 0 && values.slice(1).every((value, index) => value >= values[index]),
      location: [...samples].reverse().find(Boolean)?.location
    };
  }).filter((entry) => entry.growth !== 0);

  entries.sort((left, right) =>
    Number(right.consistentlyGrowing) - Number(left.consistentlyGrowing)
    || right.growth - left.growth
  );
  const totals = sessions.map((session) => session.total);
  return {
    sessions,
    totals,
    totalGrowth: totals.at(-1)! - totals[0],
    entries
  };
}
