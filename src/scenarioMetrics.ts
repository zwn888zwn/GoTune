import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface MetricsAdapter {
  kind: 'json-command' | 'regex-command' | 'prometheus';
  command?: string;
  patterns?: Record<string, string>;
  urls?: Record<string, string>;
}

export async function collectScenarioMetrics(options: {
  adapter: MetricsAdapter;
  directory: string;
  environment: Record<string, string>;
  selectedMetrics: string[];
}): Promise<Record<string, number>> {
  if (options.adapter.kind === 'prometheus') {
    return collectPrometheusMetrics(options.adapter.urls ?? {});
  }
  if (!options.adapter.command) throw new Error('The metrics command is missing');
  const result = await execAsync(options.adapter.command, {
    cwd: options.directory,
    env: { ...process.env, ...options.environment },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 2 * 60 * 1000
  });
  return options.adapter.kind === 'json-command'
    ? parseJsonMetrics(result.stdout, options.selectedMetrics)
    : parseRegexMetrics(result.stdout, options.adapter.patterns ?? {});
}

export async function collectPrometheusMetrics(
  urls: Record<string, string>
): Promise<Record<string, number>> {
  const entries = await Promise.all(Object.entries(urls).map(async ([name, url]) => {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'GoTune/0.6' },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`Prometheus metric ${name} returned HTTP ${response.status}`);
    return [name, parsePrometheusValue(await response.json())] as const;
  }));
  return Object.fromEntries(entries);
}

export function parsePrometheusValue(payload: unknown): number {
  const response = payload as {
    status?: string;
    error?: string;
    data?: { resultType?: string; result?: unknown };
  };
  if (response.status !== 'success' || !response.data) {
    throw new Error(response.error || 'Prometheus returned an unsuccessful query response');
  }
  const { resultType, result } = response.data;
  let encodedValue: unknown;
  if (resultType === 'scalar') {
    encodedValue = Array.isArray(result) ? result[1] : undefined;
  } else if (resultType === 'vector') {
    if (!Array.isArray(result) || result.length !== 1) {
      throw new Error('Prometheus instant query must return exactly one series per scenario metric');
    }
    const sample = result[0] as { value?: unknown };
    encodedValue = Array.isArray(sample.value) ? sample.value[1] : undefined;
  } else if (resultType === 'matrix') {
    if (!Array.isArray(result) || result.length !== 1) {
      throw new Error('Prometheus range query must return exactly one series per scenario metric');
    }
    const series = result[0] as { values?: unknown };
    const values = Array.isArray(series.values) ? series.values : [];
    const sample = values.at(-1);
    encodedValue = Array.isArray(sample) ? sample[1] : undefined;
  } else {
    throw new Error(`Unsupported Prometheus result type: ${resultType ?? 'missing'}`);
  }
  const value = Number(encodedValue);
  if (!Number.isFinite(value)) {
    throw new Error('Prometheus did not return a finite numeric sample');
  }
  return value;
}

export function parseJsonMetrics(
  output: string,
  selectedMetrics: string[]
): Record<string, number> {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const parsed = JSON.parse(lines[index]) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const flattened = flattenNumbers(parsed as Record<string, unknown>);
      const names = selectedMetrics.length > 0 ? selectedMetrics : Object.keys(flattened);
      const result = Object.fromEntries(
        names.flatMap((name) =>
          typeof flattened[name] === 'number' ? [[name, flattened[name]]] : []
        )
      );
      if (Object.keys(result).length > 0) return result;
    } catch {
      // Commands may print logs before their final JSON Lines metric object.
    }
  }
  throw new Error('The metrics command did not print a JSON object with numeric fields');
}

export function parseRegexMetrics(
  output: string,
  patterns: Record<string, string>
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [name, pattern] of Object.entries(patterns)) {
    const match = new RegExp(pattern, 'm').exec(output);
    const value = match ? Number(match[1] ?? match[0]) : Number.NaN;
    if (Number.isFinite(value)) result[name] = value;
  }
  if (Object.keys(result).length === 0) {
    throw new Error('None of the metric regular expressions matched a numeric value');
  }
  return result;
}

export function parseMetricPatternSpec(spec: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of spec.split(';')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const name = entry.slice(0, separator).trim();
    const pattern = entry.slice(separator + 1).trim();
    if (name && pattern) result[name] = pattern;
  }
  return result;
}

function flattenNumbers(
  value: Record<string, unknown>,
  prefix = ''
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, child] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'number' && Number.isFinite(child)) {
      result[name] = child;
    } else if (child && typeof child === 'object' && !Array.isArray(child)) {
      Object.assign(result, flattenNumbers(child as Record<string, unknown>, name));
    }
  }
  return result;
}
