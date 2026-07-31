import { buildProfileInsights } from './insights';
import { GoroutineSnapshot } from './goroutine';
import { MemoryTrend } from './memoryTrend';
import {
  EvidenceKind,
  Investigation,
  PerformanceFinding,
  ProfileComparison,
  ProblemKind,
  ProfileSession
} from './model';

export function createInvestigation(
  problem: ProblemKind,
  target?: string,
  now = Date.now()
): Investigation {
  return {
    id: `${now}-${Math.random().toString(36).slice(2)}`,
    name: investigationName(problem),
    problem,
    target,
    captureIds: [],
    findings: [],
    baselineByMetric: {},
    createdAt: now,
    updatedAt: now
  };
}

export function addCaptureToInvestigation(
  investigation: Investigation,
  session: ProfileSession,
  now = Date.now()
): Investigation {
  const findings = buildProfileInsights(session).map((insight, index): PerformanceFinding => ({
    id: `${session.id}-${index}`,
    investigationId: investigation.id,
    captureId: session.id,
    kind: evidenceKind(session.sampleType),
    severity: insight.kind === 'warning' ? 'watch' : 'info',
    title: insight.title,
    detail: insight.detail,
    functionName: hotspotAtLocation(session, insight.location?.file, insight.location?.line)?.name,
    location: insight.location,
    createdAt: now
  }));
  return {
    ...investigation,
    target: investigation.target ?? session.target,
    captureIds: [...new Set([...investigation.captureIds, session.id])],
    findings: [
      ...investigation.findings.filter((finding) => finding.captureId !== session.id),
      ...findings
    ],
    updatedAt: now
  };
}

export function addFindingsToInvestigation(
  investigation: Investigation,
  findings: PerformanceFinding[],
  sourcePrefix: string,
  now = Date.now()
): Investigation {
  return {
    ...investigation,
    findings: [
      ...investigation.findings.filter((finding) => !finding.id.startsWith(sourcePrefix)),
      ...findings
    ],
    updatedAt: now
  };
}

export function rankFindings(
  findings: PerformanceFinding[],
  targetFindingId?: string
): PerformanceFinding[] {
  return [...findings].sort((left, right) =>
    Number(right.id === targetFindingId) - Number(left.id === targetFindingId)
    || findingSeverityRank(right.severity) - findingSeverityRank(left.severity)
    || Number(Boolean(right.location)) - Number(Boolean(left.location))
    || right.createdAt - left.createdAt
  );
}

export function findingsFromMemoryTrend(
  investigationId: string,
  trend: MemoryTrend,
  now = Date.now(),
  idPrefix = 'memory-trend'
): PerformanceFinding[] {
  const subject = trend.sessions[0]?.sampleUnit === 'count' ? 'Live objects' : 'Live memory';
  const growing = trend.entries
    .filter((entry) => entry.growth > 0)
    .slice(0, 20);
  if (growing.length === 0) {
    return [{
      id: `${idPrefix}-${now}-stable`,
      investigationId,
      kind: 'live-memory',
      severity: 'verified',
      title: `No persistent ${subject.toLowerCase()} growth found`,
      detail: 'Three post-GC captures did not show a continuously growing business-code allocation site.',
      createdAt: now
    }];
  }
  return growing.map((entry, index) => ({
    id: `${idPrefix}-${now}-${index}`,
    investigationId,
    kind: 'live-memory',
    severity: entry.consistentlyGrowing ? 'suspicious' : 'watch',
    title: entry.consistentlyGrowing
      ? `${subject} keeps growing: ${shortName(entry.name)}`
      : `${subject} changed: ${shortName(entry.name)}`,
    detail: `${formatMetric(entry.growth, trend.sessions[0]?.sampleUnit ?? 'bytes')} growth across three post-GC captures.${entry.consistentlyGrowing
      ? ' The allocation site increased in every capture.'
      : ' The samples fluctuated, so this is not yet persistent leak evidence.'}`,
    functionName: entry.name,
    location: entry.location,
    createdAt: now
  }));
}

export function findingsFromGoroutines(
  investigationId: string,
  snapshot: GoroutineSnapshot,
  now = Date.now(),
  isApplicationSource: (file: string) => boolean = () => true
): PerformanceFinding[] {
  const candidates = snapshot.groups
    .filter((group) => group.severity !== 'normal')
    .slice(0, 30);
  if (candidates.length === 0) {
    return [{
      id: `goroutine-${now}-stable`,
      investigationId,
      kind: 'goroutine',
      severity: 'verified',
      title: 'No stable suspicious goroutine stack found',
      detail: `${snapshot.total} goroutines were observed; repeated samples did not identify a suspicious stable blocking group.`,
      createdAt: now
    }];
  }
  return candidates.map((group, index) => {
    const frame = group.frames.find((candidate) =>
      candidate.file
      && candidate.line
      && isApplicationSource(candidate.file)
    ) ?? group.frames.find((candidate) => candidate.file && candidate.line);
    return {
      id: `goroutine-${now}-${index}`,
      investigationId,
      kind: 'goroutine',
      severity: group.severity === 'suspicious' ? 'suspicious' : 'watch',
      title: `${group.count} goroutines stay in ${group.state}`,
      detail: group.explanation,
      functionName: frame?.functionName ?? group.topFunction,
      location: frame?.file && frame.line ? { file: frame.file, line: frame.line } : undefined,
      createdAt: now
    };
  });
}

export function findingsFromComparison(
  investigationId: string,
  comparison: ProfileComparison,
  now = Date.now()
): PerformanceFinding[] {
  const businessEntries = comparison.entries
    .filter((entry) => entry.delta !== 0 && entry.location)
    .slice(0, 20);
  if (businessEntries.length === 0) {
    return [{
      id: `verification-${comparison.current.id}-stable`,
      investigationId,
      captureId: comparison.current.id,
      kind: evidenceKind(comparison.current.sampleType),
      severity: 'verified',
      title: 'No function-level regression found',
      detail: `No changed source-mapped function was found against baseline ${comparison.baseline.name}.`,
      createdAt: now
    }];
  }
  return businessEntries.map((entry, index) => {
    const regression = entry.delta > 0;
    const percentText = entry.deltaPercent === undefined
      ? ''
      : ` (${entry.deltaPercent > 0 ? '+' : ''}${entry.deltaPercent.toFixed(1)}%)`;
    return {
      id: `verification-${comparison.current.id}-${index}`,
      investigationId,
      captureId: comparison.current.id,
      kind: evidenceKind(comparison.current.sampleType),
      severity: regression ? 'watch' : 'verified',
      title: `${regression ? 'Regression' : 'Improved'}: ${shortName(entry.name)}`,
      detail: `${regression ? '+' : ''}${formatMetric(entry.delta, comparison.current.sampleUnit)}${percentText} versus ${comparison.baseline.name}.`,
      functionName: entry.name,
      location: entry.location,
      createdAt: now
    };
  });
}

export function evidenceKind(sampleType: string): EvidenceKind {
  if (sampleType === 'cpu') return 'cpu';
  if (/goroutine/i.test(sampleType)) return 'goroutine';
  if (/^alloc_/.test(sampleType)) return 'allocation';
  if (/^inuse_/.test(sampleType)) return 'live-memory';
  if (/delay|contentions|mutex|block/i.test(sampleType)) return 'blocking';
  return 'trace';
}

export function problemForSampleType(sampleType: string): ProblemKind {
  const kind = evidenceKind(sampleType);
  if (kind === 'cpu') return 'cpu';
  if (kind === 'allocation') return 'allocations';
  if (kind === 'live-memory') return 'memory-growth';
  if (kind === 'blocking' || kind === 'goroutine') return 'blocking';
  return 'code';
}

export function investigationName(problem: ProblemKind): string {
  if (problem === 'cpu') return 'CPU usage is high';
  if (problem === 'memory-growth') return 'Memory keeps growing';
  if (problem === 'allocations') return 'Too many allocations or GC pressure';
  if (problem === 'blocking') return 'Request stuck or goroutines blocked';
  if (problem === 'latency') return 'Operation or request is slow';
  return 'Inspect current code';
}

function hotspotAtLocation(session: ProfileSession, file?: string, line?: number) {
  if (!file || !line) return undefined;
  return session.hotspots.find((hotspot) =>
    hotspot.location?.file === file && hotspot.location.line === line
  );
}

function shortName(name: string): string {
  const slash = name.lastIndexOf('/');
  return name.slice(slash + 1);
}

function findingSeverityRank(severity: PerformanceFinding['severity']): number {
  if (severity === 'suspicious') return 3;
  if (severity === 'watch') return 2;
  if (severity === 'verified') return 1;
  return 0;
}

function formatBytes(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  if (absolute >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MiB`;
  if (absolute >= 1024) return `${(value / 1024).toFixed(2)} KiB`;
  return `${value.toFixed(0)} B`;
}

function formatMetric(value: number, unit: string): string {
  if (unit === 'bytes') return formatBytes(value);
  if (unit === 'nanoseconds') {
    const absolute = Math.abs(value);
    if (absolute >= 1e9) return `${(value / 1e9).toFixed(2)} s`;
    if (absolute >= 1e6) return `${(value / 1e6).toFixed(2)} ms`;
    if (absolute >= 1e3) return `${(value / 1e3).toFixed(2)} µs`;
    return `${value.toFixed(0)} ns`;
  }
  return value.toLocaleString();
}
