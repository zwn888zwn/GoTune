import * as vscode from 'vscode';
import { StructLayoutField, StructLayoutResult } from './structLayout';

export function showStructLayoutPanel(
  result: StructLayoutResult,
  onApply: () => void
): void {
  const panel = vscode.window.createWebviewPanel(
    'gotune.structLayout',
    `GoTune: ${result.name} layout`,
    vscode.ViewColumn.Beside,
    { enableScripts: true }
  );
  const nonce = Math.random().toString(36).slice(2);
  const saved = result.size - result.optimizedSize;
  panel.webview.html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px}
h1{font-size:20px}.cards{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.card{min-width:150px;background:var(--vscode-editor-inactiveSelectionBackground);padding:10px 12px}.card strong{display:block;font-size:20px}
.layout{display:grid;grid-template-columns:1fr 1fr;gap:18px}table{width:100%;border-collapse:collapse}th,td{text-align:right;padding:6px;border-bottom:1px solid var(--vscode-panel-border)}th:nth-child(2),td:nth-child(2){text-align:left}
.warning{border-left:3px solid var(--vscode-editorWarning-foreground);padding:9px 12px;background:var(--vscode-textBlockQuote-background);margin:12px 0}
button{border:0;padding:7px 11px;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button[disabled]{opacity:.5}
pre{white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:12px}
</style></head><body>
<h1>${escapeHtml(result.name)} field layout</h1>
<div>${escapeHtml(result.file)}:${result.line}</div>
<div class="cards">
  <div class="card"><strong>${result.size} B</strong><span>Current size</span></div>
  <div class="card"><strong>${result.optimizedSize} B</strong><span>Suggested size</span></div>
  <div class="card"><strong>${saved} B</strong><span>Saved per object</span></div>
  <div class="card"><strong>${formatBytes(saved * 100_000)}</strong><span>At 100,000 objects</span></div>
</div>
${result.safetyReasons?.length ? `<div class="warning"><b>Preview only</b><br>${result.safetyReasons.map(escapeHtml).join('<br>')}</div>` : ''}
<div class="layout"><section><h2>Current</h2>${layoutTable(result.fields)}</section>
<section><h2>Suggested</h2>${layoutTable(result.optimizedFields)}</section></div>
<p><button id="apply" ${!result.safeToApply || !result.optimizedSource || saved <= 0 ? 'disabled' : ''}>Apply safe field reorder</button></p>
${result.optimizedSource ? `<details><summary>Preview exact rewritten source</summary><pre>${escapeHtml(result.optimizedSource)}</pre></details>` : ''}
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
document.getElementById('apply')?.addEventListener('click',()=>vscode.postMessage({command:'apply'}));
</script></body></html>`;
  panel.webview.onDidReceiveMessage((message) => {
    if (message?.command === 'apply' && result.safeToApply && result.optimizedSource) {
      onApply();
    }
  });
}

function layoutTable(fields: StructLayoutField[]): string {
  return `<table><thead><tr><th>Offset</th><th>Field</th><th>Type</th><th>Size</th><th>Padding</th></tr></thead><tbody>
${fields.map((field) => `<tr><td>${field.offset}</td><td>${escapeHtml(field.name)}</td><td>${escapeHtml(field.type)}</td><td>${field.size}</td><td>${field.padding}</td></tr>`).join('')}
</tbody></table>`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} KiB`;
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
