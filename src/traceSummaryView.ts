import * as vscode from 'vscode';
import { TraceSummary, TraceSummaryEntry } from './traceSummary';
import { formatValue } from './webview';

export function showTraceSummaryPanel(
  summary: TraceSummary,
  onOpenSource: (file: string, line: number) => void,
  onOpenTimeline: () => void
): void {
  const panel = vscode.window.createWebviewPanel(
    'gotune.traceSummary',
    'GoTune: Operation Timing Evidence',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const nonce = Math.random().toString(36).slice(2);
  panel.webview.html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${nonce}">
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:18px}
    h1{font-size:20px;margin:0 0 5px}.summary{color:var(--vscode-descriptionForeground);margin-bottom:15px}
    .notice{border-left:3px solid var(--vscode-charts-blue);background:var(--vscode-textBlockQuote-background);padding:10px 12px;margin-bottom:15px}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}.card{border:1px solid var(--vscode-panel-border);border-radius:5px;padding:12px}
    .card h2{font-size:15px;margin:0 0 8px}.metric{font-size:20px;font-weight:600}.label,.source{color:var(--vscode-descriptionForeground);font-size:12px}.source{margin-top:8px}
    button{border:0;padding:6px 10px;margin-top:10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
    button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
  </style>
</head>
<body>
  <h1>Operation timing evidence</h1>
  <div class="summary">Trace capture window: ${(summary.captureDurationMs / 1000).toFixed(1)} s</div>
  <div class="notice">
    These values are aggregate delay across all goroutines, not a single request wall-clock breakdown.
    They can exceed the capture window. Use the source locations to find dominant waits; use the raw
    timeline when exact request ordering or regions matter.
  </div>
  <div class="cards">${summary.entries.map(entryHtml).join('')}</div>
  <button class="secondary" data-command="timeline">Open advanced trace timeline</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', event => {
      const button = event.target.closest('button[data-command]');
      if (!button) return;
      vscode.postMessage({
        command: button.dataset.command,
        file: button.dataset.file,
        line: Number(button.dataset.line)
      });
    });
  </script>
</body>
</html>`;
  panel.webview.onDidReceiveMessage((message) => {
    if (message?.command === 'timeline') {
      onOpenTimeline();
    } else if (
      message?.command === 'source'
      && typeof message.file === 'string'
      && Number.isFinite(message.line)
    ) {
      onOpenSource(message.file, message.line);
    }
  });
}

function entryHtml(entry: TraceSummaryEntry): string {
  const top = entry.top;
  return `<div class="card">
    <h2>${kindLabel(entry.kind)}</h2>
    <div class="metric">${formatValue(entry.total, entry.unit)}</div>
    <div class="label">aggregate sampled goroutine delay</div>
    ${top ? `<div class="source">
      Top path: <b>${escapeHtml(top.name)}</b><br>
      ${formatValue(top.value, entry.unit)} · ${top.percent.toFixed(1)}%
    </div>
    ${top.location
      ? `<button data-command="source" data-file="${escapeHtml(top.location.file)}" data-line="${top.location.line}">Open source</button>`
      : ''}` : '<div class="source">No sampled delay in this category.</div>'}
  </div>`;
}

function kindLabel(kind: TraceSummaryEntry['kind']): string {
  if (kind === 'net') return 'Network wait';
  if (kind === 'sync') return 'Synchronization wait';
  if (kind === 'syscall') return 'Syscall wait';
  return 'Scheduler delay';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
