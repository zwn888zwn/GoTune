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
  value: number;
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
  hotspots: Hotspot[];
  callTree: CallNode[];
  lineMetrics: LineMetric[];
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
