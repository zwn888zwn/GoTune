import {
  EvidenceKind,
  GoFunctionReference,
  Hotspot,
  ProfileSession,
  SourceLocation
} from './model';
import { evidenceKind } from './investigation';

export interface FunctionEvidenceItem {
  sessionId: string;
  sessionName: string;
  kind: EvidenceKind;
  sampleType: string;
  sampleUnit: string;
  self: number;
  cumulative: number;
  total: number;
  selfPercent: number;
  cumulativePercent: number;
  baselineDelta?: number;
  baselineDeltaPercent?: number;
  primaryCaller?: {
    name: string;
    value: number;
    location?: SourceLocation;
  };
  hotspot: Hotspot;
}

export interface FunctionEvidenceReport {
  function: GoFunctionReference;
  items: FunctionEvidenceItem[];
  availableKinds: EvidenceKind[];
}

export function collectFunctionEvidence(
  fn: GoFunctionReference,
  sessions: ProfileSession[],
  baselineSessionId?: string
): FunctionEvidenceReport {
  const baseline = sessions.find((session) => session.id === baselineSessionId);
  const items = sessions.flatMap((session): FunctionEvidenceItem[] => {
    const hotspot = findFunctionHotspot(fn, session);
    if (!hotspot) return [];
    const baselineHotspot = baseline
      && baseline.sampleType === session.sampleType
      && baseline.sampleUnit === session.sampleUnit
      ? findFunctionHotspot(fn, baseline)
      : undefined;
    const baselineDelta = baselineHotspot && baseline?.id !== session.id
      ? hotspot.cumulative - baselineHotspot.cumulative
      : undefined;
    return [{
      sessionId: session.id,
      sessionName: session.name,
      kind: evidenceKind(session.sampleType),
      sampleType: session.sampleType,
      sampleUnit: session.sampleUnit,
      self: hotspot.flat,
      cumulative: hotspot.cumulative,
      total: session.total,
      selfPercent: percent(hotspot.flat, session.total),
      cumulativePercent: percent(hotspot.cumulative, session.total),
      baselineDelta,
      baselineDeltaPercent: baselineDelta === undefined || !baselineHotspot?.cumulative
        ? undefined
        : baselineDelta / baselineHotspot.cumulative * 100,
      primaryCaller: findPrimaryCaller(session, hotspot),
      hotspot
    }];
  });
  return {
    function: fn,
    items,
    availableKinds: [...new Set(items.map((item) => item.kind))]
  };
}

export function findFunctionHotspot(
  fn: GoFunctionReference,
  session: ProfileSession
): Hotspot | undefined {
  const bySource = session.hotspots
    .filter((hotspot) =>
      hotspot.location
      && sameSource(fn.file, hotspot.location.file)
      && hotspot.location.line >= fn.startLine
      && hotspot.location.line <= fn.endLine
    )
    .sort((left, right) => right.cumulative - left.cumulative)[0];
  if (bySource) return bySource;
  return session.hotspots
    .filter((hotspot) => functionNameMatches(hotspot.name, fn.name))
    .sort((left, right) => right.cumulative - left.cumulative)[0];
}

function findPrimaryCaller(session: ProfileSession, hotspot: Hotspot): FunctionEvidenceItem['primaryCaller'] {
  let result: FunctionEvidenceItem['primaryCaller'];
  const visit = (
    nodes: ProfileSession['callTree'],
    parent?: { name: string; value: number; location?: SourceLocation }
  ): void => {
    for (const node of nodes) {
      if (
        (node.id === hotspot.id || node.name === hotspot.name)
        && parent
        && (!result || parent.value > result.value)
      ) {
        result = parent;
      }
      visit(node.children, { name: node.name, value: node.value, location: node.location });
    }
  };
  visit(session.callTree);
  return result;
}

function functionNameMatches(profileName: string, symbolName: string): boolean {
  return profileName === symbolName
    || profileName.endsWith(`.${symbolName}`)
    || profileName.endsWith(`).${symbolName}`);
}

function percent(value: number, total: number): number {
  return total === 0 ? 0 : value / total * 100;
}

function sameSource(left: string, right: string): boolean {
  const normalize = (value: string) => value.replaceAll('\\', '/');
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}
