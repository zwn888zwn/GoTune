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
  groups: GoroutineGroup[];
}

interface TrackedGroup {
  stableCaptures: number;
  generation: number;
  count: number;
}

export class GoroutineTracker {
  private generation = 0;
  private tracked = new Map<string, TrackedGroup>();
  private previousTotal = 0;

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
      this.tracked.set(signature, { stableCaptures, generation: this.generation, count: entries.length });
      const first = entries[0];
      const severity = classifySeverity(first.state, stableCaptures, entries.length, countDelta);
      return {
        signature,
        state: first.state,
        waitDetail: first.waitDetail,
        count: entries.length,
        countDelta,
        topFunction: first.frames[0]?.functionName ?? 'unknown',
        frames: first.frames,
        representative: first.raw,
        stableCaptures,
        severity,
        explanation: severityExplanation(first.state, severity, stableCaptures, entries.length, countDelta)
      } satisfies GoroutineGroup;
    });

    groups.sort((left, right) =>
      severityRank(right.severity) - severityRank(left.severity)
      || right.count - left.count
      || left.state.localeCompare(right.state)
    );
    const totalDelta = this.generation === 1 ? 0 : goroutines.length - this.previousTotal;
    this.previousTotal = goroutines.length;
    return {
      capturedAt: Date.now(),
      total: goroutines.length,
      stateCount: new Set(goroutines.map((goroutine) => goroutine.state)).size,
      suspiciousCount: groups
        .filter((group) => group.severity === 'suspicious')
        .reduce((sum, group) => sum + group.count, 0),
      totalDelta,
      groups
    };
  }

  reset(): void {
    this.generation = 0;
    this.tracked.clear();
    this.previousTotal = 0;
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
  return `${goroutine.state}\n${goroutine.frames.map((frame) => frame.functionName).join('\n')}`;
}

function isGoTuneGoroutine(goroutine: GoroutineInfo): boolean {
  return goroutine.frames.some((frame) => frame.file?.endsWith('/zz_gotune_profiler.go'))
    || goroutine.frames[0]?.functionName === 'runtime/pprof.writeGoroutineStacks';
}

function classifySeverity(
  state: string,
  stableCaptures: number,
  count: number,
  countDelta: number
): GoroutineSeverity {
  if (/^(?:running|runnable|IO wait|sleep|GC worker|force gc)/i.test(state)) {
    return countDelta > 0 && stableCaptures >= 2 ? 'watch' : 'normal';
  }
  const blocking = /chan (?:receive|send)|semacquire|sync\.Mutex|select|sync\.Cond|WaitGroup/i.test(state);
  if (blocking && stableCaptures >= 2 && (countDelta > 0 || count >= 2 || stableCaptures >= 3)) return 'suspicious';
  return blocking ? 'watch' : 'normal';
}

function severityExplanation(
  state: string,
  severity: GoroutineSeverity,
  stableCaptures: number,
  count: number,
  countDelta: number
): string {
  if (severity === 'suspicious') {
    const growth = countDelta > 0 ? ` and grew by ${countDelta}` : '';
    return `${count} goroutine(s) stayed in ${state} for ${stableCaptures} consecutive captures${growth}; verify that the owning operation still makes progress.`;
  }
  if (severity === 'watch') {
    if (countDelta > 0) {
      return `${state} grew by ${countDelta} goroutine(s); repeat the same workload and confirm whether the count returns.`;
    }
    return `${state} can be normal, but repeated unchanged captures may indicate a blocked channel or lock.`;
  }
  if (/IO wait/i.test(state)) return 'Waiting for network or file I/O; normally expected in servers.';
  if (/running|runnable/i.test(state)) return 'Currently running or ready to run.';
  return `${state} is not considered suspicious from a single snapshot.`;
}

function severityRank(severity: GoroutineSeverity): number {
  return severity === 'suspicious' ? 2 : severity === 'watch' ? 1 : 0;
}
