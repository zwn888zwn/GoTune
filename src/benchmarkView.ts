import * as vscode from 'vscode';
import { BenchmarkMeasurement } from './benchmark';

export interface BenchmarkSnapshot {
  capturedAt: number;
  measurements: BenchmarkMeasurement[];
  gitCommit?: string;
  gitDirty?: boolean;
}

export function showBenchmarkPanel(
  scenarioName: string,
  current: BenchmarkSnapshot,
  baseline?: BenchmarkSnapshot
): void {
  const panel = vscode.window.createWebviewPanel(
    'gotune.benchmark',
    `GoTune: ${scenarioName}`,
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );
  const baselineByName = new Map(
    baseline?.measurements.map((measurement) => [measurement.name, measurement]) ?? []
  );
  panel.webview.html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px}
h1{font-size:20px}.summary{color:var(--vscode-descriptionForeground);margin-bottom:18px}
table{width:100%;border-collapse:collapse}th,td{text-align:right;padding:8px;border-bottom:1px solid var(--vscode-panel-border)}
th:first-child,td:first-child{text-align:left}.better{color:var(--vscode-testing-iconPassed)}.worse{color:var(--vscode-testing-iconFailed)}
</style></head><body>
<h1>${escapeHtml(scenarioName)} benchmark</h1>
  <div class="summary">${baseline ? 'Compared with the first run baseline.' : 'Baseline captured. Run the same scenario after editing code to verify the change.'}
  ${current.gitCommit ? `Commit ${escapeHtml(current.gitCommit.slice(0, 10))}${current.gitDirty ? ' · tracked changes present' : ''}.` : ''}</div>
<table><thead><tr><th>Benchmark</th><th>ns/op</th><th>Delta</th><th>B/op</th><th>Delta</th><th>allocs/op</th><th>Delta</th></tr></thead>
<tbody>${current.measurements.map((measurement) => {
    const before = baselineByName.get(measurement.name);
    return `<tr><td>${escapeHtml(measurement.name)}</td>
<td>${number(measurement.nsPerOp)}</td><td>${delta(before?.nsPerOp, measurement.nsPerOp)}</td>
<td>${number(measurement.bytesPerOp)}</td><td>${delta(before?.bytesPerOp, measurement.bytesPerOp)}</td>
<td>${number(measurement.allocsPerOp)}</td><td>${delta(before?.allocsPerOp, measurement.allocsPerOp)}</td></tr>`;
  }).join('')}</tbody></table>
</body></html>`;
}

function delta(before?: number, after?: number): string {
  if (before === undefined || after === undefined || before === 0) return '—';
  const percent = (after - before) / before * 100;
  const className = percent < 0 ? 'better' : percent > 0 ? 'worse' : '';
  return `<span class="${className}">${percent > 0 ? '+' : ''}${percent.toFixed(1)}%</span>`;
}

function number(value?: number): string {
  return value === undefined ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
