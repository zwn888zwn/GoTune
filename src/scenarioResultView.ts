import * as vscode from 'vscode';
import { ScenarioRunRecord } from './model';

export function showScenarioResultPanel(
  scenarioName: string,
  current: ScenarioRunRecord,
  baseline?: ScenarioRunRecord
): void {
  const panel = vscode.window.createWebviewPanel(
    'gotune.scenarioResult',
    `GoTune: ${scenarioName} result`,
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );
  const metricNames = [...new Set([
    ...Object.keys(baseline?.metrics ?? {}),
    ...Object.keys(current.metrics)
  ])];
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px}
h1{font-size:20px}.meta{color:var(--vscode-descriptionForeground);margin-bottom:15px}
table{width:100%;border-collapse:collapse}th,td{text-align:right;padding:7px 8px;border-bottom:1px solid var(--vscode-panel-border)}th:first-child,td:first-child{text-align:left}
.better{color:var(--vscode-testing-iconPassed)}.worse{color:var(--vscode-testing-iconFailed)}.notice{padding:10px 12px;background:var(--vscode-textBlockQuote-background);border-left:3px solid var(--vscode-charts-blue)}
</style></head><body>
<h1>${escapeHtml(scenarioName)}</h1>
<div class="meta">Commit ${escapeHtml(shortCommit(current.gitCommit))}${current.gitDirty ? ' · working tree had tracked changes' : ''} · ${current.captureIds.length} runtime evidence capture(s)</div>
${metricNames.length === 0
    ? '<div class="notice">Runtime evidence was captured. Add a metrics command to verify throughput, latency, errors, or another business outcome alongside pprof.</div>'
    : `<table><thead><tr><th>Metric</th><th>Baseline</th><th>Current</th><th>Delta</th></tr></thead><tbody>
${metricNames.map((name) => metricRow(name, baseline?.metrics[name], current.metrics[name])).join('')}
</tbody></table>`}
</body></html>`;
}

function metricRow(name: string, before?: number, after?: number): string {
  const percent = before === undefined || after === undefined || before === 0
    ? undefined
    : (after - before) / before * 100;
  const lowerIsBetter = /(?:latency|p\\d+|error|cpu|alloc|heap|memory|mutex|block|goroutine)/i.test(name);
  const improved = percent !== undefined && (lowerIsBetter ? percent < 0 : percent > 0);
  const regressed = percent !== undefined && (lowerIsBetter ? percent > 0 : percent < 0);
  return `<tr><td>${escapeHtml(name)}</td><td>${format(before)}</td><td>${format(after)}</td>
<td class="${improved ? 'better' : regressed ? 'worse' : ''}">${percent === undefined ? '—' : `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`}</td></tr>`;
}

function format(value?: number): string {
  return value === undefined ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function shortCommit(commit?: string): string {
  return commit ? commit.slice(0, 10) : 'unknown';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
