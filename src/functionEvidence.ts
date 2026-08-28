import {
  EvidenceKind,
  GoFunctionReference,
  Hotspot,
  PerformanceFinding,
  ProfileSession,
  SourceLocation
} from './model';
import { evidenceKind } from './investigation';
import { sourcePathsMatch } from './sourcePath';

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
  primaryCallees: Array<{
    name: string;
    value: number;
    location?: SourceLocation;
  }>;
  hotspot: Hotspot;
}

export interface FunctionEvidenceReport {
  function: GoFunctionReference;
  items: FunctionEvidenceItem[];
  findings: PerformanceFinding[];
  availableKinds: EvidenceKind[];
}

export function collectFunctionEvidence(
  fn: GoFunctionReference,
  sessions: ProfileSession[],
  baselineSessionIds?: string | string[],
  sourcePathMappings: Record<string, string> = {},
  findings: PerformanceFinding[] = []
): FunctionEvidenceReport {
  const baselineIds = new Set(
    typeof baselineSessionIds === 'string'
      ? [baselineSessionIds]
      : baselineSessionIds ?? []
  );
  const baselines = sessions.filter((session) => baselineIds.has(session.id));
  const items = sessions.flatMap((session): FunctionEvidenceItem[] => {
    const hotspot = findFunctionHotspot(fn, session, sourcePathMappings);
    if (!hotspot) return [];
    const baseline = baselines.find((candidate) =>
      candidate.id !== session.id
      && comparableSessions(candidate, session)
    );
    const baselineHotspot = baseline
      && baseline.sampleType === session.sampleType
      && baseline.sampleUnit === session.sampleUnit
      ? findFunctionHotspot(fn, baseline, sourcePathMappings)
      : undefined;
    const baselineDelta = baselineHotspot && baseline?.id !== session.id
      ? hotspot.cumulative - baselineHotspot.cumulative
      : undefined;
    const callContext = findCallContext(session, hotspot);
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
      primaryCaller: callContext.primaryCaller,
      primaryCallees: callContext.primaryCallees,
      hotspot
    }];
  });
  const matchingFindings = findings
    .filter((finding) =>
      finding.location
        ? sourcePathsMatch(fn.file, finding.location.file, sourcePathMappings)
          && finding.location.line >= fn.startLine
          && finding.location.line <= fn.endLine
        : Boolean(finding.functionName && functionNameMatches(finding.functionName, fn.name))
    )
    .sort((left, right) =>
      findingSeverityRank(right.severity) - findingSeverityRank(left.severity)
      || right.createdAt - left.createdAt
    );
  return {
    function: fn,
    items,
    findings: matchingFindings,
    availableKinds: [...new Set([
      ...items.map((item) => item.kind),
      ...matchingFindings.map((finding) => finding.kind)
    ])]
  };
}

function comparableSessions(left: ProfileSession, right: ProfileSession): boolean {
  if (left.sampleType !== right.sampleType || left.sampleUnit !== right.sampleUnit) return false;
  if (left.target && right.target && left.target !== right.target) return false;
  if (left.scenarioId && right.scenarioId && left.scenarioId !== right.scenarioId) return false;
  if (
    left.captureDurationMs
    && right.captureDurationMs
    && left.captureDurationMs !== right.captureDurationMs
  ) {
    return false;
  }
  if (
    /^alloc_/.test(right.sampleType)
    && (left.captureMode !== 'delta' || right.captureMode !== 'delta')
  ) {
    return false;
  }
  return true;
}

export function findFunctionHotspot(
  fn: GoFunctionReference,
  session: ProfileSession,
  sourcePathMappings: Record<string, string> = {}
): Hotspot | undefined {
  const bySource = session.hotspots
    .filter((hotspot) =>
      hotspot.location
      && sourcePathsMatch(fn.file, hotspot.location.file, sourcePathMappings)
      && hotspot.location.line >= fn.startLine
      && hotspot.location.line <= fn.endLine
    )
    .sort((left, right) => right.cumulative - left.cumulative)[0];
  if (bySource) return bySource;
  const byName = session.hotspots
    .filter((hotspot) => functionNameMatches(hotspot.name, fn.name))
    .sort((left, right) => right.cumulative - left.cumulative);
  return byName.length === 1 ? byName[0] : undefined;
}

function findCallContext(
  session: ProfileSession,
  hotspot: Hotspot
): Pick<FunctionEvidenceItem, 'primaryCaller' | 'primaryCallees'> {
  let primaryCaller: FunctionEvidenceItem['primaryCaller'];
  let primaryCallees: FunctionEvidenceItem['primaryCallees'] = [];
  let bestCalleeValue = -1;
  const visit = (
    nodes: ProfileSession['callTree'],
    parent?: { name: string; value: number; location?: SourceLocation }
  ): void => {
    for (const node of nodes) {
      if (
        (node.id === hotspot.id || node.name === hotspot.name)
        && parent
        && parent.value > (primaryCaller?.value ?? -1)
      ) {
        primaryCaller = parent;
      }
      if (
        (node.id === hotspot.id || node.name === hotspot.name)
        && node.value > bestCalleeValue
      ) {
        bestCalleeValue = node.value;
        primaryCallees = [...node.children]
          .sort((left, right) => right.value - left.value)
          .slice(0, 5)
          .map((child) => ({
            name: child.name,
            value: child.value,
            location: child.location
          }));
      }
      visit(node.children, { name: node.name, value: node.value, location: node.location });
    }
  };
  visit(session.callTree);
  return { primaryCaller, primaryCallees };
}

function functionNameMatches(profileName: string, symbolName: string): boolean {
  return profileName === symbolName
    || profileName.endsWith(`.${symbolName}`)
    || profileName.endsWith(`).${symbolName}`);
}

function percent(value: number, total: number): number {
  return total === 0 ? 0 : value / total * 100;
}

function findingSeverityRank(severity: PerformanceFinding['severity']): number {
  if (severity === 'suspicious') return 3;
  if (severity === 'watch') return 2;
  if (severity === 'verified') return 1;
  return 0;
}
