import * as vscode from 'vscode';
import { isRuntimeFunction, isRuntimeHotspot, isRuntimeLine } from './classify';
import { GoroutineSnapshot } from './goroutine';
import { buildProfileInsights, profileMeaning } from './insights';
import { MemoryTrend } from './memoryTrend';
import { CallNode, ProfileComparison, ProfileSession } from './model';

export function formatValue(value: number, unit: string): string {
  if (unit === 'nanoseconds') {
    if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)} s`;
    if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)} ms`;
    if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(2)} µs`;
    return `${value.toFixed(0)} ns`;
  }
  if (unit === 'bytes') {
    if (Math.abs(value) >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
    if (Math.abs(value) >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MiB`;
    if (Math.abs(value) >= 1024) return `${(value / 1024).toFixed(2)} KiB`;
    return `${value.toFixed(0)} B`;
  }
  return new Intl.NumberFormat().format(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function callRows(nodes: CallNode[], session: ProfileSession, depth = 0): string {
  return nodes.slice(0, depth === 0 ? 30 : 12).map((node) => {
    const percent = session.total === 0 ? 0 : node.value / session.total * 100;
    const location = node.location ? `${node.location.file}:${node.location.line}` : '';
    return `<tr class="source-row" data-file="${escapeHtml(node.location?.file ?? '')}" data-line="${node.location?.line ?? 0}">
      <td style="padding-left:${depth * 18 + 8}px">${escapeHtml(node.name)}</td>
      <td>${formatValue(node.value, session.sampleUnit)}</td>
      <td>${percent.toFixed(1)}%</td>
      <td>${escapeHtml(location)}</td>
    </tr>${callRows(node.children, session, depth + 1)}`;
  }).join('');
}

function flameNodes(nodes: CallNode[], total: number, depth = 0): string {
  if (depth > 12) return '';
  return nodes.map((node) => {
    const width = total === 0 ? 0 : node.value / total * 100;
    if (width < 0.25) return '';
    return `<div class="flame" style="width:${width}%" title="${escapeHtml(node.name)} · ${width.toFixed(1)}%"
      data-file="${escapeHtml(node.location?.file ?? '')}" data-line="${node.location?.line ?? 0}">
      <span>${escapeHtml(node.name)}</span>
      <div class="children">${flameNodes(node.children, node.value, depth + 1)}</div>
    </div>`;
  }).join('');
}

export function showRuntimeOverviewPanel(
  onAction: (command: 'cpu' | 'memory' | 'goroutines') => void
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'gotune.runtimeOverview',
    'GoTune: Live Performance',
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
    h1{font-size:18px;margin:0 0 4px}.summary,.hint{color:var(--vscode-descriptionForeground)}.summary{margin-bottom:14px}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;margin-bottom:16px}.card{background:var(--vscode-editor-inactiveSelectionBackground);padding:10px 12px;border-radius:4px}.card strong{display:block;font-size:18px}.card span{font-size:12px;color:var(--vscode-descriptionForeground)}
    .chart{border:1px solid var(--vscode-panel-border);padding:10px;margin-bottom:14px}.chart-head{display:flex;justify-content:space-between;margin-bottom:8px}
    svg{width:100%;height:190px;background:var(--vscode-editor-background)}.heap{fill:none;stroke:var(--vscode-charts-blue);stroke-width:3}.goroutines{fill:none;stroke:var(--vscode-charts-orange);stroke-width:2}.legend{display:flex;gap:18px;font-size:12px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}.dot.heap-dot{background:var(--vscode-charts-blue)}.dot.g-dot{background:var(--vscode-charts-orange)}
    .actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.action{text-align:left;border:1px solid var(--vscode-panel-border);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:11px 12px;cursor:pointer}.action:hover{background:var(--vscode-button-secondaryHoverBackground)}.action b{display:block;margin-bottom:3px}
  </style>
</head>
<body>
  <h1>Live Performance Overview / 实时性能总览</h1>
  <div class="summary">最近 60 秒运行时趋势。发现异常后，选择下面的问题入口获取函数、文件和代码行证据。</div>
  <div class="cards">
    <div class="card"><strong id="heap">—</strong><span>Current live heap</span></div>
    <div class="card"><strong id="objects">—</strong><span>Live heap objects</span></div>
    <div class="card"><strong id="goroutine">—</strong><span>Goroutines</span></div>
    <div class="card"><strong id="alloc-rate">—</strong><span>Allocation rate</span></div>
    <div class="card"><strong id="gc">—</strong><span>GC count</span></div>
    <div class="card"><strong id="pause">—</strong><span>GC pause since last sample</span></div>
  </div>
  <div class="chart">
    <div class="chart-head"><b>Runtime trend</b><div class="legend"><span><i class="dot heap-dot"></i>Heap</span><span><i class="dot g-dot"></i>Goroutines</span></div></div>
    <svg viewBox="0 0 600 180" preserveAspectRatio="none"><polyline id="heap-line" class="heap" points=""></polyline><polyline id="goroutine-line" class="goroutines" points=""></polyline></svg>
  </div>
  <div class="actions">
    <button class="action" data-action="cpu"><b>CPU 高或操作很慢</b><span class="hint">采集 CPU，再跳到最热函数和代码行</span></button>
    <button class="action" data-action="memory"><b>内存不断上涨</b><span class="hint">三次强制 GC，找持续增长的分配点</span></button>
    <button class="action" data-action="goroutines"><b>请求卡住或 goroutine 不退</b><span class="hint">连续采样阻塞栈和数量变化</span></button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const samples = [];
    const bytes = value => {
      if (value >= 1073741824) return (value / 1073741824).toFixed(2) + ' GiB';
      if (value >= 1048576) return (value / 1048576).toFixed(2) + ' MiB';
      if (value >= 1024) return (value / 1024).toFixed(2) + ' KiB';
      return Math.round(value) + ' B';
    };
    const points = (values, height = 170) => {
      const max = Math.max(...values, 1);
      const min = Math.min(...values, 0);
      const span = Math.max(max - min, 1);
      return values.map((value, index) => {
        const x = values.length <= 1 ? 0 : index / (values.length - 1) * 600;
        const y = height - (value - min) / span * (height - 10);
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
    };
    window.addEventListener('message', event => {
      if (event.data.command !== 'metrics') return;
      const current = event.data.metrics;
      const previous = samples.at(-1);
      samples.push(current);
      if (samples.length > 60) samples.shift();
      document.getElementById('heap').textContent = bytes(current.heapAlloc);
      document.getElementById('objects').textContent = new Intl.NumberFormat().format(current.heapObjects);
      document.getElementById('goroutine').textContent = new Intl.NumberFormat().format(current.goroutines);
      document.getElementById('gc').textContent = new Intl.NumberFormat().format(current.numGC);
      if (previous) {
        const seconds = Math.max((current.timestamp - previous.timestamp) / 1000, 0.001);
        document.getElementById('alloc-rate').textContent = bytes(Math.max(0, current.totalAlloc - previous.totalAlloc) / seconds) + '/s';
        document.getElementById('pause').textContent = ((current.pauseTotalNs - previous.pauseTotalNs) / 1000000).toFixed(2) + ' ms';
      }
      document.getElementById('heap-line').setAttribute('points', points(samples.map(sample => sample.heapAlloc)));
      document.getElementById('goroutine-line').setAttribute('points', points(samples.map(sample => sample.goroutines)));
    });
    document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
      vscode.postMessage({command:'action',action:button.dataset.action});
    }));
  </script>
</body>
</html>`;
  panel.webview.onDidReceiveMessage((message) => {
    if (
      message?.command === 'action'
      && (message.action === 'cpu' || message.action === 'memory' || message.action === 'goroutines')
    ) {
      onAction(message.action);
    }
  });
  return panel;
}

export function showProfilePanel(session: ProfileSession, onOpenSource: (file: string, line: number) => void): void {
  const panel = vscode.window.createWebviewPanel(
    'gotune.profile',
    `GoTune: ${session.name}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const nonce = Math.random().toString(36).slice(2);
  const mappedHotspots = session.hotspots.filter((hotspot) => hotspot.location).length;
  const hottest = session.hotspots[0];
  const insights = buildProfileInsights(session);
  panel.webview.html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${nonce}">
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:18px}
    h1{font-size:18px;margin:0 0 4px}.summary{color:var(--vscode-descriptionForeground);margin-bottom:14px}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:0 0 18px}.card{background:var(--vscode-editor-inactiveSelectionBackground);padding:10px 12px;border-radius:4px}.card strong{display:block;font-size:18px}.card span{color:var(--vscode-descriptionForeground);font-size:12px}
    .notice{border-left:3px solid var(--vscode-charts-blue);background:var(--vscode-textBlockQuote-background);padding:10px 12px;color:var(--vscode-descriptionForeground)}
    .meaning{border-left:3px solid var(--vscode-charts-blue);background:var(--vscode-textBlockQuote-background);padding:10px 12px;margin-bottom:10px}
    .insights{display:grid;gap:8px;margin-bottom:16px}.insight{padding:10px 12px;border:1px solid var(--vscode-panel-border);border-radius:4px}.insight[data-file]:not([data-file=""]){cursor:pointer}.insight:hover{background:var(--vscode-list-hoverBackground)}.insight strong{display:block;margin-bottom:4px}.insight span{color:var(--vscode-descriptionForeground)}
    .tabs{display:flex;gap:8px;margin-bottom:12px}.tabs button{color:inherit;background:var(--vscode-button-secondaryBackground);border:0;padding:6px 12px}
    .tabs button.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
    section{display:none}section.active{display:block}table{border-collapse:collapse;width:100%}th,td{padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);text-align:left}
    .source-row[data-file]:not([data-file=""]){cursor:pointer}.source-row:hover{background:var(--vscode-list-hoverBackground)}
    .toolbar{display:flex;gap:8px;align-items:center;margin-bottom:8px}.toolbar input{width:min(420px,70vw);padding:6px 8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}
    .toolbar button{padding:6px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0}.hint{color:var(--vscode-descriptionForeground);font-size:12px}
    .flame-root{display:flex;align-items:flex-end;min-height:300px}.flame{box-sizing:border-box;display:flex;flex-direction:column-reverse;min-height:25px;border:1px solid var(--vscode-editor-background);background:var(--vscode-charts-orange);overflow:hidden;cursor:pointer}
    .flame:nth-child(3n+2){background:var(--vscode-charts-yellow)}.flame:nth-child(3n){background:var(--vscode-charts-red)}
    .flame>span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:4px;color:var(--vscode-editor-background)}
    .children{display:flex;align-items:flex-end;width:100%}
  </style>
</head>
<body>
  <h1>${escapeHtml(session.name)}</h1>
  <div class="summary">${escapeHtml(session.sampleType)} · ${formatValue(session.total, session.sampleUnit)} · ${escapeHtml(session.source)}</div>
  <div class="cards">
    <div class="card"><strong>${formatValue(session.total, session.sampleUnit)}</strong><span>Total ${escapeHtml(session.sampleType)}</span></div>
    <div class="card"><strong>${session.hotspots.length}</strong><span>Functions sampled</span></div>
    <div class="card"><strong>${mappedHotspots}</strong><span>Functions mapped to source</span></div>
    <div class="card"><strong>${escapeHtml(hottest ? displayShortName(hottest.name) : '—')}</strong><span>Hottest function</span></div>
  </div>
  <div class="meaning"><b>这个 Profile 表示：</b>${escapeHtml(profileMeaning(session.sampleType))}</div>
  <div class="insights">
    ${insights.map((insight) => `<div class="insight" data-file="${escapeHtml(insight.location?.file ?? '')}" data-line="${insight.location?.line ?? 0}">
      <strong>${insight.kind === 'warning' ? '⚠ ' : ''}${escapeHtml(insight.title)}</strong>
      <span>${escapeHtml(insight.detail)}${insight.location ? ' · 点击打开源码' : ''}</span>
    </div>`).join('')}
  </div>
  <div class="tabs"><button class="active" data-tab="top">Top</button><button data-tab="flame">Flame Graph</button><button data-tab="calls">Call Tree</button><button data-tab="source">Source</button></div>
  <section id="top" class="active"><div class="toolbar"><input id="top-filter" placeholder="Filter functions or source paths"><label class="hint"><input id="hide-runtime" type="checkbox" checked> Hide Go runtime</label></div><table><thead><tr><th>Function</th><th>Flat</th><th>Cumulative</th><th>Source</th></tr></thead><tbody>
    ${session.hotspots.length === 0
      ? `<tr><td colspan="4"><div class="notice">No ${escapeHtml(session.sampleType)} samples were recorded. For CPU profiles, generate workload while the capture is running.</div></td></tr>`
      : session.hotspots.slice(0, 100).map((hotspot) => `<tr class="source-row top-row" data-runtime="${isRuntimeHotspot(hotspot)}" data-filter="${escapeHtml(`${hotspot.name} ${hotspot.location?.file ?? ''}`.toLowerCase())}" data-file="${escapeHtml(hotspot.location?.file ?? '')}" data-line="${hotspot.location?.line ?? 0}">
      <td>${escapeHtml(hotspot.name)}</td><td>${formatValue(hotspot.flat, session.sampleUnit)}</td><td>${formatValue(hotspot.cumulative, session.sampleUnit)}</td>
      <td>${escapeHtml(hotspot.location ? `${hotspot.location.file}:${hotspot.location.line}` : '')}</td></tr>`).join('')}
  </tbody></table></section>
  <section id="flame"><div class="toolbar"><button id="flame-reset" disabled>Reset zoom</button><span class="hint">Click to open source · Shift+click to zoom</span></div><div class="flame-root">${flameNodes(session.callTree, session.total)}</div></section>
  <section id="calls"><table><thead><tr><th>Call path</th><th>Value</th><th>Total</th><th>Source</th></tr></thead><tbody>${callRows(session.callTree, session)}</tbody></table></section>
  <section id="source"><table><thead><tr><th>Source line</th><th>Function</th><th>Value</th><th>Total</th></tr></thead><tbody>
    ${[...session.lineMetrics].sort((left, right) => right.value - left.value).slice(0, 200).map((metric) => {
      const percent = session.total === 0 ? 0 : metric.value / session.total * 100;
      return `<tr class="source-row source-metric" data-runtime="${isRuntimeLine(metric)}" data-file="${escapeHtml(metric.file)}" data-line="${metric.line}"><td>${escapeHtml(`${metric.file}:${metric.line}`)}</td><td>${escapeHtml(metric.functionName)}</td><td>${formatValue(metric.value, session.sampleUnit)}</td><td>${percent.toFixed(1)}%</td></tr>`;
    }).join('')}
  </tbody></table></section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('.tabs button').forEach(button => button.addEventListener('click', () => {
      document.querySelectorAll('.tabs button,section').forEach(element => element.classList.remove('active'));
      button.classList.add('active'); document.getElementById(button.dataset.tab).classList.add('active');
    }));
    const topFilter = document.getElementById('top-filter');
    const hideRuntime = document.getElementById('hide-runtime');
    const updateVisibility = () => {
      const query = topFilter.value.trim().toLowerCase();
      document.querySelectorAll('.top-row').forEach(row => {
        row.hidden = !row.dataset.filter.includes(query) || (hideRuntime.checked && row.dataset.runtime === 'true');
      });
      document.querySelectorAll('.source-metric').forEach(row => {
        row.hidden = hideRuntime.checked && row.dataset.runtime === 'true';
      });
    };
    topFilter.addEventListener('input', updateVisibility);
    hideRuntime.addEventListener('change', updateVisibility);
    updateVisibility();
    const flameRoot = document.querySelector('.flame-root');
    const originalFlame = flameRoot.innerHTML;
    const reset = document.getElementById('flame-reset');
    reset.addEventListener('click', () => { flameRoot.innerHTML = originalFlame; reset.disabled = true; });
    document.addEventListener('click', event => {
      const target = event.target.closest('[data-file]');
      if (event.shiftKey && target?.classList.contains('flame')) {
        const copy = target.cloneNode(true);
        copy.style.width = '100%';
        flameRoot.replaceChildren(copy);
        reset.disabled = false;
        return;
      }
      if (target && target.dataset.file) vscode.postMessage({ command:'source', file:target.dataset.file, line:Number(target.dataset.line) });
    });
  </script>
</body>
</html>`;
  panel.webview.onDidReceiveMessage((message) => {
    if (message?.command === 'source' && typeof message.file === 'string' && typeof message.line === 'number') {
      onOpenSource(message.file, message.line);
    }
  });
}

export function showMemoryTrendPanel(
  trend: MemoryTrend,
  onOpenSource: (file: string, line: number) => void
): void {
  const panel = vscode.window.createWebviewPanel(
    'gotune.memoryTrend',
    'GoTune: Memory Growth',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const nonce = Math.random().toString(36).slice(2);
  const growing = trend.entries.filter((entry) => entry.consistentlyGrowing && entry.growth > 0);
  const growthClass = trend.totalGrowth > 0 ? 'bad' : 'good';
  const verdict = growing.length > 0
    ? `发现 ${growing.length} 个连续增长的业务代码分配点，需要进一步确认对象为什么仍被引用。`
    : '没有发现连续三次都增长的业务代码分配点；目前没有明确的泄漏证据。';

  panel.webview.html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${nonce}">
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:18px}
    h1{font-size:18px;margin:0 0 4px}.summary{color:var(--vscode-descriptionForeground);margin-bottom:14px}
    .verdict{border-left:3px solid ${growing.length > 0 ? 'var(--vscode-testing-iconFailed)' : 'var(--vscode-testing-iconPassed)'};background:var(--vscode-textBlockQuote-background);padding:11px 13px;margin-bottom:14px}
    .cards{display:grid;grid-template-columns:repeat(${trend.totals.length + 1},minmax(130px,1fr));gap:8px;margin-bottom:16px}.card{background:var(--vscode-editor-inactiveSelectionBackground);padding:10px 12px;border-radius:4px}.card strong{display:block;font-size:18px}.card span,.hint{font-size:12px;color:var(--vscode-descriptionForeground)}
    .bad{color:var(--vscode-testing-iconFailed)}.good{color:var(--vscode-testing-iconPassed)}
    table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--vscode-panel-border)}.number{text-align:right;font-variant-numeric:tabular-nums}
    tr[data-file]:not([data-file=""]){cursor:pointer}tbody tr:hover{background:var(--vscode-list-hoverBackground)}.badge{display:inline-block;padding:2px 7px;border-radius:10px;background:var(--vscode-testing-iconFailed);color:var(--vscode-editor-background);font-size:11px}
  </style>
</head>
<body>
  <h1>Memory Growth / 内存增长检测</h1>
  <div class="summary">三次快照均在强制 GC 后采集；这里展示仍存活内存的变化。</div>
  <div class="verdict"><b>结论：</b>${escapeHtml(verdict)}</div>
  <div class="cards">
    ${trend.totals.map((total, index) => `<div class="card"><strong>${formatValue(total, 'bytes')}</strong><span>${index === 0 ? 'Baseline' : `Round ${index}`} live heap</span></div>`).join('')}
    <div class="card"><strong class="${growthClass}">${trend.totalGrowth > 0 ? '+' : ''}${formatValue(trend.totalGrowth, 'bytes')}</strong><span>Total change</span></div>
  </div>
  <table>
    <thead><tr><th>业务函数</th>${trend.totals.map((_, index) => `<th class="number">${index === 0 ? 'Baseline' : `Round ${index}`}</th>`).join('')}<th class="number">增长</th><th>判断</th><th>源码</th></tr></thead>
    <tbody>
      ${trend.entries.filter((entry) => entry.growth > 0).slice(0, 100).map((entry) => {
        const source = entry.location ? `${entry.location.file}:${entry.location.line}` : '';
        return `<tr data-file="${escapeHtml(entry.location?.file ?? '')}" data-line="${entry.location?.line ?? 0}">
          <td>${escapeHtml(entry.name)}</td>
          ${entry.values.map((value) => `<td class="number">${formatValue(value, 'bytes')}</td>`).join('')}
          <td class="number bad">+${formatValue(entry.growth, 'bytes')}</td>
          <td>${entry.consistentlyGrowing ? '<span class="badge">持续增长</span>' : '<span class="hint">有波动</span>'}</td>
          <td>${escapeHtml(source)}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', event => {
      const row = event.target.closest('tr[data-file]');
      if (row?.dataset.file) vscode.postMessage({command:'source',file:row.dataset.file,line:Number(row.dataset.line)});
    });
  </script>
</body>
</html>`;
  panel.webview.onDidReceiveMessage((message) => {
    if (message?.command === 'source' && typeof message.file === 'string' && typeof message.line === 'number') {
      onOpenSource(message.file, message.line);
    }
  });
}

function displayShortName(name: string): string {
  const slash = name.lastIndexOf('/');
  return name.slice(slash + 1);
}

export function showComparisonPanel(
  comparison: ProfileComparison,
  onOpenSource: (file: string, line: number) => void
): void {
  const { baseline, current } = comparison;
  const panel = vscode.window.createWebviewPanel(
    'gotune.comparison',
    `GoTune Diff: ${baseline.name} → ${current.name}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const nonce = Math.random().toString(36).slice(2);
  const regressions = comparison.entries.filter((entry) => entry.delta > 0).length;
  const improvements = comparison.entries.filter((entry) => entry.delta < 0).length;
  const totalClass = comparison.totalDelta > 0 ? 'bad' : comparison.totalDelta < 0 ? 'good' : '';
  const totalPercent = comparison.totalDeltaPercent === undefined
    ? 'new'
    : `${comparison.totalDeltaPercent > 0 ? '+' : ''}${comparison.totalDeltaPercent.toFixed(1)}%`;
  const topRegression = comparison.entries.find((entry) =>
    entry.delta > 0 && entry.location && !isRuntimeFunction(entry.name, entry.location.file)
  );
  const comparisonVerdict = comparison.totalDelta > 0
    ? `总量增加 ${formatValue(comparison.totalDelta, current.sampleUnit)}。${topRegression ? `业务代码中增长最多的是 ${displayShortName(topRegression.name)}（+${formatValue(topRegression.delta, current.sampleUnit)}）。` : '请查看下面的增长项。'}`
    : comparison.totalDelta < 0
      ? `总量减少 ${formatValue(Math.abs(comparison.totalDelta), current.sampleUnit)}，当前结果低于基线。`
      : '总量没有变化，请继续查看函数级差异。';

  panel.webview.html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${nonce}">
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:18px}
    h1{font-size:18px;margin:0 0 4px}.summary{color:var(--vscode-descriptionForeground);margin-bottom:14px}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-bottom:18px}.card{background:var(--vscode-editor-inactiveSelectionBackground);padding:10px 12px;border-radius:4px}.card strong{display:block;font-size:18px}.card span{font-size:12px;color:var(--vscode-descriptionForeground)}
    .good{color:var(--vscode-testing-iconPassed)}.bad{color:var(--vscode-testing-iconFailed)}
    .toolbar{display:flex;gap:12px;align-items:center;margin-bottom:10px}.toolbar input{width:min(420px,65vw);padding:6px 8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}
    .toolbar label{font-size:12px;color:var(--vscode-descriptionForeground)}
    table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--vscode-panel-border)}
    tr[data-file]:not([data-file=""]){cursor:pointer}tbody tr:hover{background:var(--vscode-list-hoverBackground)}
    .number{text-align:right;font-variant-numeric:tabular-nums}
    .verdict{border-left:3px solid ${comparison.totalDelta > 0 ? 'var(--vscode-testing-iconFailed)' : 'var(--vscode-testing-iconPassed)'};background:var(--vscode-textBlockQuote-background);padding:10px 12px;margin-bottom:14px}.verdict[data-file]:not([data-file=""]){cursor:pointer}
  </style>
</head>
<body>
  <h1>Profile comparison</h1>
  <div class="summary">${escapeHtml(baseline.name)} → ${escapeHtml(current.name)} · ${escapeHtml(current.sampleType)} (${escapeHtml(current.sampleUnit)})</div>
  <div class="verdict" data-file="${escapeHtml(topRegression?.location?.file ?? '')}" data-line="${topRegression?.location?.line ?? 0}"><b>结论：</b>${escapeHtml(comparisonVerdict)}${topRegression ? ' 点击打开源码。' : ''}</div>
  <div class="cards">
    <div class="card"><strong>${formatValue(baseline.total, baseline.sampleUnit)}</strong><span>Baseline total</span></div>
    <div class="card"><strong>${formatValue(current.total, current.sampleUnit)}</strong><span>Current total</span></div>
    <div class="card"><strong class="${totalClass}">${totalPercent}</strong><span>Total change</span></div>
    <div class="card"><strong><span class="bad">${regressions} regressions</span> · <span class="good">${improvements} improvements</span></strong><span>Changed functions</span></div>
  </div>
  <div class="toolbar"><input id="filter" placeholder="Filter functions or source paths"><label><input id="changed" type="checkbox" checked> Changed only</label><label><input id="runtime" type="checkbox" checked> Hide Go runtime</label></div>
  <table>
    <thead><tr><th>Function</th><th class="number">Before</th><th class="number">After</th><th class="number">Delta</th><th class="number">Change</th><th>Source</th></tr></thead>
    <tbody>
      ${comparison.entries.map((entry) => {
        const deltaClass = entry.delta > 0 ? 'bad' : entry.delta < 0 ? 'good' : '';
        const deltaText = `${entry.delta > 0 ? '+' : ''}${formatValue(entry.delta, current.sampleUnit)}`;
        const percent = entry.deltaPercent === undefined
          ? entry.after === 0 ? 'removed' : 'new'
          : `${entry.deltaPercent > 0 ? '+' : ''}${entry.deltaPercent.toFixed(1)}%`;
        const source = entry.location ? `${entry.location.file}:${entry.location.line}` : '';
        return `<tr data-changed="${entry.delta !== 0}" data-runtime="${isRuntimeFunction(entry.name, entry.location?.file)}" data-filter="${escapeHtml(`${entry.name} ${source}`.toLowerCase())}" data-file="${escapeHtml(entry.location?.file ?? '')}" data-line="${entry.location?.line ?? 0}">
          <td>${escapeHtml(entry.name)}</td><td class="number">${formatValue(entry.before, current.sampleUnit)}</td><td class="number">${formatValue(entry.after, current.sampleUnit)}</td>
          <td class="number ${deltaClass}">${deltaText}</td><td class="number ${deltaClass}">${percent}</td><td>${escapeHtml(source)}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const filter = document.getElementById('filter');
    const changed = document.getElementById('changed');
    const runtime = document.getElementById('runtime');
    const update = () => {
      const query = filter.value.trim().toLowerCase();
      document.querySelectorAll('tbody tr').forEach(row => {
        row.hidden = !row.dataset.filter.includes(query)
          || (changed.checked && row.dataset.changed !== 'true')
          || (runtime.checked && row.dataset.runtime === 'true');
      });
    };
    filter.addEventListener('input', update); changed.addEventListener('change', update); runtime.addEventListener('change', update); update();
    document.addEventListener('click', event => {
      const row = event.target.closest('[data-file]');
      if (row?.dataset.file) vscode.postMessage({command:'source',file:row.dataset.file,line:Number(row.dataset.line)});
    });
  </script>
</body>
</html>`;
  panel.webview.onDidReceiveMessage((message) => {
    if (message?.command === 'source' && typeof message.file === 'string' && typeof message.line === 'number') {
      onOpenSource(message.file, message.line);
    }
  });
}

export function showGoroutineInspector(
  snapshot: GoroutineSnapshot,
  onOpenSource: (file: string, line: number) => void
): void {
  const panel = vscode.window.createWebviewPanel(
    'gotune.goroutines',
    `GoTune Goroutines ${new Date(snapshot.capturedAt).toLocaleTimeString()}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const nonce = Math.random().toString(36).slice(2);
  const watched = snapshot.groups
    .filter((group) => group.severity !== 'normal')
    .reduce((sum, group) => sum + group.count, 0);
  const states = [...new Set(snapshot.groups.map((group) => group.state))].sort();

  panel.webview.html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${nonce}">
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:18px}
    h1{font-size:18px;margin:0 0 4px}.summary,.hint{color:var(--vscode-descriptionForeground)}
    .summary{margin-bottom:14px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:16px}
    .card{background:var(--vscode-editor-inactiveSelectionBackground);padding:10px 12px;border-radius:4px}.card strong{display:block;font-size:18px}.card span{font-size:12px;color:var(--vscode-descriptionForeground)}
    .notice{border-left:3px solid var(--vscode-charts-blue);background:var(--vscode-textBlockQuote-background);padding:9px 12px;margin-bottom:14px}
    .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}.toolbar input,.toolbar select{padding:6px 8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}
    .toolbar input{width:min(380px,60vw)}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--vscode-panel-border)}
    .group-row{cursor:pointer}.group-row:hover{background:var(--vscode-list-hoverBackground)}.number{text-align:right;font-variant-numeric:tabular-nums}
    .badge{display:inline-block;border-radius:10px;padding:2px 7px;font-size:11px}.normal{background:var(--vscode-badge-background)}.watch{background:var(--vscode-charts-yellow);color:var(--vscode-editor-background)}.suspicious{background:var(--vscode-testing-iconFailed);color:var(--vscode-editor-background)}
    .stack-row td{padding:0 12px 12px}.stack-row pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--vscode-textCodeBlock-background);padding:10px}.explanation{margin:8px 0;color:var(--vscode-descriptionForeground)}
    button.open-source{border:0;background:none;color:var(--vscode-textLink-foreground);cursor:pointer;padding:0}
  </style>
</head>
<body>
  <h1>Goroutine Inspector</h1>
  <div class="summary">Captured ${new Date(snapshot.capturedAt).toLocaleString()} · tool-owned goroutines excluded</div>
  <div class="cards">
    <div class="card"><strong>${snapshot.total}${snapshot.totalDelta === 0 ? '' : ` (${snapshot.totalDelta > 0 ? '+' : ''}${snapshot.totalDelta})`}</strong><span>Application goroutines / change</span></div>
    <div class="card"><strong>${snapshot.groups.length}</strong><span>Unique stack groups</span></div>
    <div class="card"><strong>${snapshot.stateCount}</strong><span>Runtime states</span></div>
    <div class="card"><strong>${snapshot.suspiciousCount}</strong><span>Suspicious after repeated captures</span></div>
  </div>
  <div class="notice">A blocked goroutine is not automatically a deadlock. Capture again while the same operation should be progressing; unchanged channel/lock groups are promoted from <b>Watch</b> to <b>Suspicious</b>.</div>
  <div class="toolbar">
    <input id="filter" placeholder="Filter state, function, or source">
    <select id="state"><option value="">All states</option>${states.map((state) => `<option value="${escapeHtml(state)}">${escapeHtml(state)}</option>`).join('')}</select>
    <label class="hint"><input id="hide-normal" type="checkbox" checked> Hide normal waits</label>
    <span class="hint">${watched} goroutine(s) need review</span>
  </div>
  <table>
    <thead><tr><th class="number">Count</th><th class="number">Change</th><th>State</th><th>Top frame</th><th>Stability</th><th>Assessment</th><th>Source</th></tr></thead>
    <tbody>
      ${snapshot.groups.map((group, index) => {
        const top = group.frames.find((frame) => frame.file) ?? group.frames[0];
        const source = top?.file ? `${top.file}:${top.line ?? 1}` : '';
        const filter = `${group.state} ${group.topFunction} ${source}`.toLowerCase();
        return `<tr class="group-row" data-index="${index}" data-state="${escapeHtml(group.state)}" data-severity="${group.severity}" data-filter="${escapeHtml(filter)}">
          <td class="number">${group.count}</td>
          <td class="number">${group.countDelta === 0 ? '—' : `${group.countDelta > 0 ? '+' : ''}${group.countDelta}`}</td>
          <td>${escapeHtml(group.state)}${group.waitDetail ? `<br><span class="hint">${escapeHtml(group.waitDetail)}</span>` : ''}</td>
          <td>${escapeHtml(group.topFunction)}</td>
          <td>${group.stableCaptures} capture${group.stableCaptures === 1 ? '' : 's'}</td>
          <td><span class="badge ${group.severity}">${group.severity}</span></td>
          <td>${top?.file ? `<button class="open-source" data-file="${escapeHtml(top.file)}" data-line="${top.line ?? 1}">${escapeHtml(source)}</button>` : ''}</td>
        </tr>
        <tr class="stack-row" data-stack="${index}" hidden><td colspan="7"><div class="explanation">${escapeHtml(group.explanation)}</div><pre>${escapeHtml(group.representative)}</pre></td></tr>`;
      }).join('')}
    </tbody>
  </table>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const filter = document.getElementById('filter');
    const state = document.getElementById('state');
    const hideNormal = document.getElementById('hide-normal');
    const update = () => {
      const query = filter.value.trim().toLowerCase();
      document.querySelectorAll('.group-row').forEach(row => {
        const hidden = !row.dataset.filter.includes(query)
          || (state.value && row.dataset.state !== state.value)
          || (hideNormal.checked && row.dataset.severity === 'normal');
        row.hidden = hidden;
        if (hidden) document.querySelector('[data-stack="' + row.dataset.index + '"]').hidden = true;
      });
    };
    filter.addEventListener('input', update); state.addEventListener('change', update); hideNormal.addEventListener('change', update); update();
    document.addEventListener('click', event => {
      const source = event.target.closest('.open-source');
      if (source) {
        event.stopPropagation();
        vscode.postMessage({command:'source',file:source.dataset.file,line:Number(source.dataset.line)});
        return;
      }
      const row = event.target.closest('.group-row');
      if (row) {
        const stack = document.querySelector('[data-stack="' + row.dataset.index + '"]');
        stack.hidden = !stack.hidden;
      }
    });
  </script>
</body>
</html>`;
  panel.webview.onDidReceiveMessage((message) => {
    if (message?.command === 'source' && typeof message.file === 'string' && typeof message.line === 'number') {
      onOpenSource(message.file, message.line);
    }
  });
}
