import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface BenchmarkMeasurement {
  name: string;
  samples: number;
  iterations: number;
  nsPerOp?: number;
  bytesPerOp?: number;
  allocsPerOp?: number;
}

export interface BenchmarkRunResult {
  measurements: BenchmarkMeasurement[];
  output: string;
  cpuProfile?: Buffer;
  memoryProfile?: Buffer;
}

export interface BenchmarkOptions {
  goExecutable: string;
  directory: string;
  environment: Record<string, string>;
  pattern: string;
  count: number;
  benchtime: string;
}

export async function runGoBenchmark(options: BenchmarkOptions): Promise<BenchmarkRunResult> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gotune-benchmark-'));
  const cpuProfilePath = path.join(temporaryDirectory, 'cpu.pprof');
  const memoryProfilePath = path.join(temporaryDirectory, 'memory.pprof');
  try {
    const args = [
      'test',
      '.',
      '-run=^$',
      `-bench=${options.pattern}`,
      '-benchmem',
      `-count=${options.count}`,
      `-benchtime=${options.benchtime}`,
      `-cpuprofile=${cpuProfilePath}`,
      `-memprofile=${memoryProfilePath}`
    ];
    const result = await execFileAsync(options.goExecutable, args, {
      cwd: options.directory,
      env: { ...process.env, ...options.environment },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15 * 60 * 1000
    });
    return {
      measurements: parseBenchmarkOutput(result.stdout),
      output: result.stdout,
      cpuProfile: await readOptionalFile(cpuProfilePath),
      memoryProfile: await readOptionalFile(memoryProfilePath)
    };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function parseBenchmarkOutput(output: string): BenchmarkMeasurement[] {
  const samples = new Map<string, Array<{
    iterations: number;
    nsPerOp?: number;
    bytesPerOp?: number;
    allocsPerOp?: number;
  }>>();
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (!/^Benchmark\S+$/.test(fields[0] ?? '') || fields.length < 3) continue;
    const iterations = Number(fields[1]);
    if (!Number.isFinite(iterations)) continue;
    const sample: {
      iterations: number;
      nsPerOp?: number;
      bytesPerOp?: number;
      allocsPerOp?: number;
    } = { iterations };
    for (let index = 2; index + 1 < fields.length; index += 2) {
      const value = Number(fields[index]);
      const unit = fields[index + 1];
      if (!Number.isFinite(value)) continue;
      if (unit === 'ns/op') sample.nsPerOp = value;
      else if (unit === 'B/op') sample.bytesPerOp = value;
      else if (unit === 'allocs/op') sample.allocsPerOp = value;
    }
    const name = fields[0].replace(/-\d+$/, '');
    const existing = samples.get(name) ?? [];
    existing.push(sample);
    samples.set(name, existing);
  }
  return [...samples.entries()].map(([name, values]) => ({
    name,
    samples: values.length,
    iterations: Math.round(median(values.map((value) => value.iterations))),
    nsPerOp: medianDefined(values.map((value) => value.nsPerOp)),
    bytesPerOp: medianDefined(values.map((value) => value.bytesPerOp)),
    allocsPerOp: medianDefined(values.map((value) => value.allocsPerOp))
  }));
}

function medianDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? median(defined) : undefined;
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

async function readOptionalFile(filename: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
