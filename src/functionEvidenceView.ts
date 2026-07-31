import * as vscode from 'vscode';
import { FunctionEvidenceItem, FunctionEvidenceReport } from './functionEvidence';
import { EvidenceKind } from './model';
import { formatValue } from './webview';

export type FunctionEvidenceAction =
  | { command: 'open-profile'; sessionId: string }
  | { command: 'analyze-escape'; sessionId: string }
  | { command: 'open-finding'; findingId: string }
  | { command: 'capture'; kind: EvidenceKind }
  | { command: 'open-related-source'; file: string; line: number }
  | { command: 'track-function' }
  | { command: 'verify-function' }
  | { command: 'open-source' };

export function showFunctionEvidencePanel(
  report: FunctionEvidenceReport,
  onAction: (action: FunctionEvidenceAction) => void
): void {
  const panel = vscode.window.createWebviewPanel(
    'gotune.functionEvidence',
    `GoTune: ${report.function.name}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const nonce = Math.random().toString(36).slice(2);
  const evidence = latestEvidence(report.items);
  const missing = (['cpu', 'allocation', 'live-memory', 'goroutine', 'trace'] as EvidenceKind[])
    .filter((kind) => !report.availableKinds.includes(kind));
  panel.webview.html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${nonce}">
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:18px}
    h1{font-size:20px;margin:0 0 4px}.summary{color:var(--vscode-descriptionForeground);margin-bottom:16px}
    .intro{border-left:3px solid var(--vscode-charts-blue);background:var(--vscode-textBlockQuote-background);padding:10px 12px;margin-bottom:14px}
    .evidence{display:grid;gap:10px}.item{border:1px solid var(--vscode-panel-border);border-radius:5px;padding:12px}
    .item h2{font-size:15px;margin:0 0 3px}.capture{font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:10px}
    .metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:7px;margin-bottom:10px}
    .metric{background:var(--vscode-editor-inactiveSelectionBackground);padding:8px 10px;border-radius:4px}.metric strong{display:block;font-size:16px}.metric span{font-size:11px;color:var(--vscode-descriptionForeground)}
    .caller,.delta{margin:7px 0;color:var(--vscode-descriptionForeground)}.good{color:var(--vscode-testing-iconPassed)}.bad{color:var(--vscode-testing-iconFailed)}
    .actions,.missing{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}button{border:0;padding:6px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
    .empty{padding:18px;border:1px dashed var(--vscode-panel-border);color:var(--vscode-descriptionForeground)}
  </style>
</head>
<body>
  <h1>${escapeHtml(report.function.name)}</h1>
  <div class="summary">${escapeHtml(report.function.file)}:${report.function.startLine}-${report.function.endLine}</div>
  <div class="intro">
    这里显示当前函数在 pprof 中的证据。自身表示直接发生在函数内，包含下游表示连同它调用的函数。
    <button class="secondary" data-command="open-source">回到源码</button>
    <button class="secondary" data-command="track-function">设为优化目标</button>
    <button data-command="verify-function">修改后验证</button>
  </div>
  <div class="evidence">
    ${evidence.length === 0 && report.findings.length === 0
      ? '<div class="empty">当前还没有与这个函数匹配的性能证据。可以直接在下面采集，不需要先离开编辑器选择 pprof 类型。</div>'
      : `${report.findings.map(findingHtml).join('')}${evidence.map(evidenceHtml).join('')}`}
  </div>
  ${missing.length > 0 ? `<div class="missing">
    <b>补充证据：</b>
    ${missing.map((kind) => `<button class="secondary" data-command="capture" data-kind="${kind}">${captureLabel(kind)}</button>`).join('')}
  </div>` : ''}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', event => {
      const button = event.target.closest('button[data-command]');
      if (!button) return;
      vscode.postMessage({
        command: button.dataset.command,
        sessionId: button.dataset.sessionId,
        kind: button.dataset.kind,
        file: button.dataset.file,
        line: Number(button.dataset.line)
      });
    });
  </script>
</body>
</html>`;
  panel.webview.onDidReceiveMessage((message) => {
    if (message?.command === 'open-profile' && typeof message.sessionId === 'string') {
      onAction({ command: 'open-profile', sessionId: message.sessionId });
    } else if (message?.command === 'open-finding' && typeof message.findingId === 'string') {
      onAction({ command: 'open-finding', findingId: message.findingId });
    } else if (message?.command === 'analyze-escape' && typeof message.sessionId === 'string') {
      onAction({ command: 'analyze-escape', sessionId: message.sessionId });
    } else if (
      message?.command === 'capture'
      && (
        message.kind === 'cpu'
        || message.kind === 'allocation'
        || message.kind === 'live-memory'
        || message.kind === 'goroutine'
        || message.kind === 'trace'
      )
    ) {
      onAction({ command: 'capture', kind: message.kind });
    } else if (message?.command === 'open-source') {
      onAction({ command: 'open-source' });
    } else if (message?.command === 'track-function') {
      onAction({ command: 'track-function' });
    } else if (message?.command === 'verify-function') {
      onAction({ command: 'verify-function' });
    } else if (
      message?.command === 'open-related-source'
      && typeof message.file === 'string'
      && Number.isFinite(message.line)
    ) {
      onAction({ command: 'open-related-source', file: message.file, line: message.line });
    }
  });
}

function findingHtml(finding: FunctionEvidenceReport['findings'][number]): string {
  return `<div class="item">
    <h2>${kindLabel(finding.kind)} · ${escapeHtml(finding.title)}</h2>
    <div class="capture">${severityLabel(finding.severity)} · 综合分析证据</div>
    <div>${escapeHtml(finding.detail)}</div>
    <div class="actions">
      <button data-command="open-finding" data-finding-id="${escapeHtml(finding.id)}">查看结论与下一步</button>
      ${finding.location
        ? relatedButton('打开证据位置', finding.location.file, finding.location.line)
        : ''}
    </div>
  </div>`;
}

function evidenceHtml(item: FunctionEvidenceItem): string {
  const delta = item.baselineDelta;
  const deltaClass = delta === undefined ? '' : delta > 0 ? 'bad' : delta < 0 ? 'good' : '';
  const deltaText = delta === undefined
    ? ''
    : `${delta > 0 ? '+' : ''}${formatValue(delta, item.sampleUnit)}${item.baselineDeltaPercent === undefined
      ? ''
      : ` (${item.baselineDeltaPercent > 0 ? '+' : ''}${item.baselineDeltaPercent.toFixed(1)}%)`}`;
  return `<div class="item">
    <h2>${kindLabel(item.kind)} · ${escapeHtml(item.sampleType)}</h2>
    <div class="capture">${escapeHtml(item.sessionName)}</div>
    <div class="metrics">
      <div class="metric"><strong>${formatValue(item.self, item.sampleUnit)}</strong><span>自身 · ${item.selfPercent.toFixed(1)}%</span></div>
      <div class="metric"><strong>${formatValue(item.cumulative, item.sampleUnit)}</strong><span>包含下游 · ${item.cumulativePercent.toFixed(1)}%</span></div>
    </div>
    ${item.primaryCaller ? `<div class="caller">主要调用方：<b>${escapeHtml(item.primaryCaller.name)}</b>
      ${item.primaryCaller.location
        ? relatedButton('查看调用方', item.primaryCaller.location.file, item.primaryCaller.location.line)
        : ''}
    </div>` : ''}
    ${item.primaryCallees.length > 0 ? `<div class="caller">主要下游：
      ${item.primaryCallees.map((callee) => callee.location
        ? relatedButton(callee.name, callee.location.file, callee.location.line)
        : `<span>${escapeHtml(callee.name)}</span>`).join(' ')}
    </div>` : ''}
    ${deltaText ? `<div class="delta ${deltaClass}">相对基线：<b>${escapeHtml(deltaText)}</b></div>` : ''}
    <div class="actions">
      <button data-command="open-profile" data-session-id="${escapeHtml(item.sessionId)}">在调用图中定位</button>
      ${item.kind === 'allocation'
        ? `<button class="secondary" data-command="analyze-escape" data-session-id="${escapeHtml(item.sessionId)}">分析逃逸</button>`
        : ''}
    </div>
  </div>`;
}

function relatedButton(label: string, file: string, line: number): string {
  return `<button class="secondary" data-command="open-related-source" data-file="${escapeHtml(file)}" data-line="${line}">${escapeHtml(label)}</button>`;
}

function kindLabel(kind: EvidenceKind): string {
  if (kind === 'cpu') return 'CPU';
  if (kind === 'allocation') return '累计分配';
  if (kind === 'live-memory') return '当前存活内存';
  if (kind === 'blocking') return '阻塞等待';
  if (kind === 'goroutine') return 'Goroutine';
  return '执行轨迹';
}

function latestEvidence(items: FunctionEvidenceItem[]): FunctionEvidenceItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.sampleType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function severityLabel(severity: FunctionEvidenceReport['findings'][number]['severity']): string {
  if (severity === 'verified') return '已确认';
  if (severity === 'suspicious') return '可疑';
  if (severity === 'watch') return '需观察';
  return '信息';
}

function captureLabel(kind: EvidenceKind): string {
  if (kind === 'cpu') return '采集 CPU';
  if (kind === 'allocation') return '采集分配';
  if (kind === 'live-memory') return '采集存活内存';
  if (kind === 'goroutine') return '检查 Goroutine 与等待';
  if (kind === 'trace') return '分析等待与执行时间';
  return `采集 ${kindLabel(kind)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
