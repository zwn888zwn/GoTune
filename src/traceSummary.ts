import { ProfileSession, SourceLocation } from './model';
import { TraceProfileKind } from './traceProfiles';

export interface TraceSummaryEntry {
  kind: TraceProfileKind;
  total: number;
  unit: string;
  top?: {
    name: string;
    value: number;
    percent: number;
    location?: SourceLocation;
  };
}

export interface TraceSummary {
  captureDurationMs: number;
  entries: TraceSummaryEntry[];
}

export function createTraceSummary(
  captureDurationMs: number,
  profiles: Array<{ kind: TraceProfileKind; session: ProfileSession }>
): TraceSummary {
  return {
    captureDurationMs,
    entries: profiles.map(({ kind, session }) => {
      const top = session.hotspots
        .filter((hotspot) => hotspot.cumulative > 0)
        .sort((left, right) =>
          Number(Boolean(right.location)) - Number(Boolean(left.location))
          || right.cumulative - left.cumulative
        )[0];
      return {
        kind,
        total: session.total,
        unit: session.sampleUnit,
        top: top ? {
          name: top.name,
          value: top.cumulative,
          percent: session.total === 0 ? 0 : top.cumulative / session.total * 100,
          location: top.location
        } : undefined
      };
    })
  };
}
