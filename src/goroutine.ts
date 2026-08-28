export type GoroutineSeverity = 'normal' | 'watch' | 'suspicious';

export interface GoroutineFrame {
  functionName: string;
  file?: string;
  line?: number;
}

export interface GoroutineInfo {
  id: number;
  state: string;
  waitDetail?: string;
  frames: GoroutineFrame[];
  raw: string;
}

export interface GoroutineGroup {
  signature: string;
  state: string;
  waitDetail?: string;
  count: number;
  countDelta: number;
  countGrowth: number;
  topFunction: string;
  frames: GoroutineFrame[];
  representative: string;
  stableCaptures: number;
  severity: GoroutineSeverity;
  explanation: string;
}

export interface GoroutineSnapshot {
  capturedAt: number;
  total: number;
  stateCount: number;
  suspiciousCount: number;
  totalDelta: number;
  totalGrowth: number;
  groups: GoroutineGroup[];
}

export interface GoroutineAssessment {
  kind: 'normal-io' | 'normal' | 'needs-more-samples' | 'possible-stall' | 'growth';
  title: string;
  detail: string;
}

interface TrackedGroup {
  stableCaptures: number;
  generation: number;
  count: number;
  initialCount: number;
}

export class GoroutineTracker {
  private generation = 0;
  private tracked = new Map<string, TrackedGroup>();
  private previousTotal = 0;
  private baselineTotal = 0;

  capture(text: string): GoroutineSnapshot {
    this.generation++;
    const goroutines = parseGoroutineDump(text).filter((goroutine) => !isGoTuneGoroutine(goroutine));
    const grouped = new Map<string, GoroutineInfo[]>();
    for (const goroutine of goroutines) {
      const signature = goroutineSignature(goroutine);
      grouped.set(signature, [...(grouped.get(signature) ?? []), goroutine]);
    }

    const groups = [...grouped.entries()].map(([signature, entries]) => {
      const previous = this.tracked.get(signature);
      const stableCaptures = previous?.generation === this.generation - 1
        ? previous.stableCaptures + 1
        : 1;
      const countDelta = previous?.generation === this.generation - 1
        ? entries.length - previous.count
        : 0;
      const initialCount = previous?.initialCount ?? entries.length;
      const countGrowth = entries.length - initialCount;
      this.tracked.set(signature, {
        stableCaptures,
        generation: this.generation,
        count: entries.length,
        initialCount
      });
      const first = entries[0];
      const severity = classifySeverity(first.state);
      return {
        signature,
        state: first.state,
        waitDetail: first.waitDetail,
        count: entries.length,
        countDelta,
        countGrowth,
        topFunction: first.frames[0]?.functionName ?? 'unknown',
        frames: first.frames,
        representative: first.raw,
        stableCaptures,
        severity,
        explanation: severityExplanation(first.state, severity, stableCaptures, entries.length, countGrowth)
      } satisfies GoroutineGroup;
    });

    groups.sort((left, right) =>
      severityRank(right.severity) - severityRank(left.severity)
      || right.count - left.count
      || left.state.localeCompare(right.state)
    );
    const totalDelta = this.generation === 1 ? 0 : goroutines.length - this.previousTotal;
    if (this.generation === 1) this.baselineTotal = goroutines.length;
    const totalGrowth = goroutines.length - this.baselineTotal;
    this.previousTotal = goroutines.length;
    return {
      capturedAt: Date.now(),
      total: goroutines.length,
      stateCount: new Set(goroutines.map((goroutine) => goroutine.state)).size,
      suspiciousCount: groups
        .filter((group) => group.severity === 'suspicious')
        .reduce((sum, group) => sum + group.count, 0),
      totalDelta,
      totalGrowth,
      groups
    };
  }

  reset(): void {
    this.generation = 0;
    this.tracked.clear();
    this.previousTotal = 0;
    this.baselineTotal = 0;
  }
}

export function parseGoroutineDump(text: string): GoroutineInfo[] {
  const header = /^goroutine (\d+) \[([^\]]+)\]:$/gm;
  const matches = [...text.matchAll(header)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? text.length : text.length;
    const body = text.slice(start, end).trim();
    const stateParts = match[2].split(',').map((part) => part.trim());
    return {
      id: Number(match[1]),
      state: stateParts[0],
      waitDetail: stateParts.slice(1).join(', ') || undefined,
      frames: parseFrames(body),
      raw: `${match[0]}\n${body}`
    };
  });
}

export function assessGoroutineSnapshot(snapshot: GoroutineSnapshot): GoroutineAssessment {
  const watched = snapshot.groups.filter((group) => group.severity === 'watch');
  const growing = watched.filter((group) => group.countGrowth > 0);
  if (growing.length > 0) {
    return {
      kind: 'growth',
      title: 'Blocking-stack count increased',
      detail: `${growing.reduce((sum, group) => sum + group.countGrowth, 0)} additional goroutine(s) were present on matching blocking stacks compared with the first capture. This is a sampled count change, not a stall or leak conclusion.`
    };
  }
  if (watched.length > 0) {
    return {
      kind: 'needs-more-samples',
      title: 'Blocking states observed',
      detail: `${watched.reduce((sum, group) => sum + group.count, 0)} goroutine(s) were sampled in channel or synchronization waits. Repeated stack samples alone do not establish whether the owning operation is making progress.`
    };
  }
  const waiting = snapshot.groups.reduce((sum, group) => sum + group.count, 0);
  const ioWaiting = snapshot.groups
    .filter((group) => /IO wait/i.test(group.state))
    .reduce((sum, group) => sum + group.count, 0);
  if (waiting > 0 && ioWaiting / waiting >= 0.5) {
    return {
      kind: 'normal-io',
      title: 'Mostly normal I/O waiting',
      detail: `${ioWaiting} of ${waiting} sampled goroutines are waiting for network or file I/O; no channel or synchronization-wait group was selected for review.`
    };
  }
  return {
    kind: 'normal',
    title: 'No configured blocking state observed',
    detail: 'The sampled stacks did not match the current channel or synchronization-wait review filter.'
  };
}

function parseFrames(body: string): GoroutineFrame[] {
  const lines = body.split(/\r?\n/);
  const frames: GoroutineFrame[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line || /^\s/.test(line)) continue;
    const functionName = normalizeFunction(line.replace(/^created by\s+/, ''));
    const sourceLine = lines[index + 1] ?? '';
    const source = /^\s+(.+):(\d+)(?:\s+\+0x[\da-f]+)?$/i.exec(sourceLine);
    frames.push({
      functionName,
      file: source?.[1],
      line: source ? Number(source[2]) : undefined
    });
  }
  return frames;
}

function normalizeFunction(value: string): string {
  const argumentStart = value.lastIndexOf('(');
  return argumentStart > 0 ? value.slice(0, argumentStart) : value;
}

function goroutineSignature(goroutine: GoroutineInfo): string {
  return `${goroutine.state}\n${goroutine.waitDetail ?? ''}\n${goroutine.frames
    .map((frame) => `${frame.functionName}@${frame.file ?? ''}:${frame.line ?? 0}`)
    .join('\n')}`;
}

function isGoTuneGoroutine(goroutine: GoroutineInfo): boolean {
  return goroutine.frames.some((frame) => frame.file?.endsWith('/zz_gotune_profiler.go'))
    || goroutine.frames[0]?.functionName === 'runtime/pprof.writeGoroutineStacks';
}

function classifySeverity(state: string): GoroutineSeverity {
  if (/^(?:running|runnable|IO wait|sleep|GC worker|force gc)/i.test(state)) {
    return 'normal';
  }
  const blocking = /chan (?:receive|send)|semacquire|sync\.Mutex|select|sync\.Cond|WaitGroup/i.test(state);
  return blocking ? 'watch' : 'normal';
}

function severityExplanation(
  state: string,
  severity: GoroutineSeverity,
  stableCaptures: number,
  count: number,
  countGrowth: number
): string {
  if (severity === 'watch') {
    if (countGrowth > 0) {
      return `${state} had ${countGrowth} more goroutine(s) than the first capture on the same source stack.`;
    }
    return `${count} goroutine(s) were sampled in ${state} on the same source stack for ${stableCaptures} capture(s); this can be normal.`;
  }
  if (/IO wait/i.test(state)) return 'Waiting for network or file I/O; normally expected in servers.';
  if (/running|runnable/i.test(state)) return 'Currently running or ready to run.';
  return `${state} was recorded as raw runtime state and was not selected by the blocking-state review filter.`;
}

function severityRank(severity: GoroutineSeverity): number {
  return severity === 'suspicious' ? 2 : severity === 'watch' ? 1 : 0;
}
