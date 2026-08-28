import * as vscode from 'vscode';
import { StructLayoutField, StructLayoutResult } from './structLayout';

export function showStructLayoutPanel(result: StructLayoutResult): void {
  const panel = vscode.window.createWebviewPanel(
    'gotune.structLayout',
    `GoTune: ${result.name} 结构体布局`,
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );
  const sizeDifference = result.size - result.optimizedSize;
  const currentPadding = totalPadding(result.fields);
  const candidatePadding = totalPadding(result.optimizedFields);
  const isModuleCache = /[\\/]pkg[\\/]mod[\\/]/.test(result.file);
  panel.webview.html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px}
h1{font-size:20px}.cards{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.card{min-width:145px;background:var(--vscode-editor-inactiveSelectionBackground);padding:10px 12px}.card strong{display:block;font-size:20px}
.layout section{margin-top:24px}table{width:100%;border-collapse:collapse}th,td{text-align:right;padding:7px 8px;border-bottom:1px solid var(--vscode-panel-border)}th:nth-child(2),td:nth-child(2),th:nth-child(3),td:nth-child(3){text-align:left}.padding{color:var(--vscode-editorWarning-foreground);font-weight:600}
.notice{border-left:3px solid var(--vscode-charts-blue);padding:9px 12px;background:var(--vscode-textBlockQuote-background);margin:12px 0}.warning{border-left-color:var(--vscode-editorWarning-foreground)}
.path,.note{color:var(--vscode-descriptionForeground);font-size:12px}.path{word-break:break-all}pre{white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:12px}
</style></head><body>
<h1>${escapeHtml(result.name)} 结构体内存布局</h1>
<div class="path">${escapeHtml(result.file)}:${result.line}</div>
<div class="cards">
  <div class="card"><strong>${result.size} B</strong><span>当前大小</span></div>
  <div class="card"><strong>${currentPadding} B</strong><span>当前填充合计</span></div>
  <div class="card"><strong>${result.optimizedSize} B</strong><span>候选顺序大小</span></div>
  <div class="card"><strong>${sizeDifference} B</strong><span>大小差值</span></div>
</div>
<div class="notice"><b>数据范围</b><br>以下是目标 GOARCH 下的原始 size、offset、alignment 和 padding。候选顺序仅按“零大小字段优先、对齐值降序、字段大小降序”计算，不代表应该修改代码。</div>
<p class="note">本检查不分析缓存行、字段访问频率、伪共享、GC 扫描成本、实例数量或实际性能收益，也不会自动修改源码。</p>
${isModuleCache ? '<div class="notice warning">这是 Go 模块缓存中的第三方依赖源码，仅展示布局数据。</div>' : ''}
<div class="layout"><section><h2>当前布局</h2>${layoutTable(result.fields)}</section>
<section><h2>候选重排布局</h2><p class="note">候选填充合计：${candidatePadding} B</p>${layoutTable(result.optimizedFields)}</section></div>
</body></html>`;
}

function totalPadding(fields: StructLayoutField[]): number {
  return fields.reduce((sum, field) => sum + field.padding, 0);
}

function layoutTable(fields: StructLayoutField[]): string {
  return `<table><thead><tr><th>偏移</th><th>字段</th><th>类型</th><th>大小</th><th>对齐</th><th>后置填充</th></tr></thead><tbody>
${fields.map((field) => `<tr><td>${field.offset}</td><td>${escapeHtml(field.name)}</td><td>${escapeHtml(field.type)}</td><td>${field.size}</td><td>${field.align}</td><td class="${field.padding ? 'padding' : ''}">${field.padding}</td></tr>`).join('')}
</tbody></table>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
