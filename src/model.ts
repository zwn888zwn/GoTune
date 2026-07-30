export interface SourceLocation {
  file: string;
  line: number;
}

export interface Hotspot {
  id: string;
  name: string;
  flat: number;
  cumulative: number;
  location?: SourceLocation;
}

export interface CallNode {
  id: string;
  name: string;
  value: number;
  location?: SourceLocation;
  children: CallNode[];
}

export interface LineMetric {
  file: string;
  line: number;
  /** Cumulative sample value for stacks passing through this source line. */
  value: number;
  /** Sample value spent directly in this source line. */
  flat?: number;
  functionName: string;
}

export interface ProfileSession {
  id: string;
  name: string;
  source: string;
  importedAt: number;
  sampleType: string;
  sampleUnit: string;
  total: number;
  target?: string;
  captureDurationMs?: number;
  processStartedAt?: number;
  captureMode?: 'snapshot' | 'delta';
  scenarioId?: string;
  hotspots: Hotspot[];
  callTree: CallNode[];
  lineMetrics: LineMetric[];
}

export type ProblemKind = 'code' | 'cpu' | 'memory-growth' | 'allocations' | 'blocking' | 'latency';
export type EvidenceKind = 'cpu' | 'allocation' | 'live-memory' | 'blocking' | 'goroutine' | 'trace';
export type FindingSeverity = 'info' | 'watch' | 'suspicious' | 'verified';

export interface PerformanceFinding {
  id: string;
  investigationId: string;
  captureId?: string;
  kind: EvidenceKind;
  severity: FindingSeverity;
  title: string;
  detail: string;
  functionName?: string;
  location?: SourceLocation;
  createdAt: number;
}

export interface Investigation {
  id: string;
  name: string;
  problem: ProblemKind;
  target?: string;
  scenarioId?: string;
  captureIds: string[];
  findings: PerformanceFinding[];
  baselineByMetric: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export type WorkloadKind = 'manual' | 'vscode-task' | 'command' | 'benchmark';

export interface PerformanceScenario {
  id: string;
  name: string;
  target?: string;
  problem: ProblemKind;
  workloadKind: WorkloadKind;
  workload?: string;
  warmupSeconds: number;
  captureSeconds: number;
  captureKinds: EvidenceKind[];
  successMetrics: string[];
  createdAt: number;
  updatedAt: number;
}

export interface GoFunctionReference {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
}

export interface ComparisonEntry {
  key: string;
  name: string;
  before: number;
  after: number;
  delta: number;
  deltaPercent?: number;
  location?: SourceLocation;
}

export interface ProfileComparison {
  baseline: ProfileSession;
  current: ProfileSession;
  totalDelta: number;
  totalDeltaPercent?: number;
  warnings: string[];
  entries: ComparisonEntry[];
}

export interface RuntimeMetrics {
  timestamp: number;
  heapAlloc: number;
  heapObjects: number;
  totalAlloc: number;
  numGC: number;
  pauseTotalNs: number;
  goroutines: number;
}
