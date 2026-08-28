import * as vscode from 'vscode';
import { isRuntimeFunction, isRuntimeHotspot, isRuntimeLine } from './classify';
import { assessGoroutineSnapshot, GoroutineSnapshot } from './goroutine';
import { profileMeaning } from './insights';
import { MemoryTrend } from './memoryTrend';
import { Hotspot, ProfileComparison, ProfileSession } from './model';
import { ProfileGraph } from './profileGraph';

export type ProfileAction = 'escape' | 'baseline' | 'compare' | 'recapture';

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

export function showProfilePanel(
  session: ProfileSession,
  onOpenSource: (file: string, line: number) => void,
  focusedHotspot?: Hotspot,
  onAction?: (action: ProfileAction, hotspot: Hotspot | undefined) => void,
  baselineState: 'none' | 'current' | 'available' = 'none',
  graph?: ProfileGraph
): void {
  const panel = vscode.window.createWebviewPanel(
    'gotune.profile',
    focusedHotspot
      ? `GoTune: ${profileMetricLabel(session.sampleType)} · ${displayShortName(focusedHotspot.name)}`
      : `GoTune: ${session.name}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const nonce = Math.random().toString(36).slice(2);
  const mappedHotspots = session.hotspots.filter((hotspot) => hotspot.location).length;
  const hottest = session.hotspots[0];
  const actionHotspot = focusedHotspot
    ?? session.hotspots.find((hotspot) => hotspot.location && !isRuntimeHotspot(hotspot))
    ?? hottest;
  const detailHotspot = focusedHotspot ?? actionHotspot;
  const graphDetails = graph?.nodes.map((node) => ({
    name: node.name,
    self: formatValue(node.flat, session.sampleUnit),
    selfPercent: session.total === 0 ? '0.0' : (node.flat / session.total * 100).toFixed(1),
    cumulative: formatValue(node.cumulative, session.sampleUnit),
    cumulativePercent: session.total === 0 ? '0.0' : (node.cumulative / session.total * 100).toFixed(1),
    source: node.location ? `${node.location.file}:${node.location.line}` : '没有源码位置'
  })) ?? [];
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
    .next-step{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 12px;margin-bottom:12px;border:1px solid var(--vscode-panel-border);border-radius:4px}.next-step strong{margin-right:4px}.next-step button{padding:6px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0}.next-step button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
    .focus{border-left:3px solid var(--vscode-focusBorder);background:var(--vscode-textBlockQuote-background);padding:10px 12px;margin-bottom:12px}
    .selected-detail{display:grid;grid-template-columns:minmax(220px,2fr) repeat(2,minmax(130px,1fr));gap:8px;padding:10px 12px;margin-bottom:12px;border:1px solid var(--vscode-focusBorder);border-radius:4px}.selected-detail strong{display:block}.selected-detail span{font-size:12px;color:var(--vscode-descriptionForeground)}
    .tabs{display:flex;gap:8px;margin-bottom:12px}.tabs button{color:inherit;background:var(--vscode-button-secondaryBackground);border:0;padding:6px 12px}
    .tabs button.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
    section{display:none}section.active{display:block}table{border-collapse:collapse;width:100%}th,td{padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);text-align:left}
    .source-row[data-file]:not([data-file=""]){cursor:pointer}.source-row:hover{background:var(--vscode-list-hoverBackground)}.source-row.focused{outline:1px solid var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground)}
    .toolbar{display:flex;gap:8px;align-items:center;margin-bottom:8px}.toolbar input{width:min(420px,70vw);padding:6px 8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}
    .toolbar button{padding:6px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0}.hint{color:var(--vscode-descriptionForeground);font-size:12px}
    .graph-wrap{height:calc(100vh - 360px);min-height:420px;overflow:auto;border:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background)}
    .profile-graph{min-width:100%;height:auto}.profile-graph g.node{cursor:pointer}.profile-graph g.node:hover polygon,.profile-graph g.node:hover path,.profile-graph g.node.selected polygon,.profile-graph g.node.selected path{stroke:var(--vscode-focusBorder);stroke-width:4}
  </style>
</head>
<body>
  <h1>${escapeHtml(session.name)}</h1>
  <div class="summary">${escapeHtml(session.sampleType)} · ${formatValue(session.total, session.sampleUnit)} · ${escapeHtml(session.source)}</div>
  <div class="cards">
    <div class="card"><strong>${formatValue(session.total, session.sampleUnit)}</strong><span>${escapeHtml(profileMetricLabel(session.sampleType))}总量</span></div>
    <div class="card"><strong>${session.hotspots.length}</strong><span>采样到的函数</span></div>
    <div class="card"><strong>${mappedHotspots}</strong><span>可跳转源码的函数</span></div>
    <div class="card"><strong>${escapeHtml(hottest ? displayShortName(hottest.name) : '—')}</strong><span>全局最高函数</span></div>
  </div>
  ${focusedHotspot ? `<div class="focus"><b>已定位当前函数：</b>${escapeHtml(focusedHotspot.name)}。调用图只展示它附近的调用方和下游；点击任意节点会回到源码并打开该函数详情。</div>` : ''}
  <div class="meaning"><b>这个 Profile 表示：</b>${escapeHtml(profileMeaning(session.sampleType, session.source, session.captureMode))}</div>
  ${detailHotspot ? `<div class="selected-detail">
    <div><strong id="detail-name">${escapeHtml(detailHotspot.name)}</strong><span id="detail-source">${escapeHtml(detailHotspot.location ? `${detailHotspot.location.file}:${detailHotspot.location.line}` : '没有源码位置')}</span></div>
    <div><strong id="detail-self">${formatValue(detailHotspot.flat, session.sampleUnit)}</strong><span id="detail-self-label">自身 · ${(session.total === 0 ? 0 : detailHotspot.flat / session.total * 100).toFixed(1)}%</span></div>
    <div><strong id="detail-cumulative">${formatValue(detailHotspot.cumulative, session.sampleUnit)}</strong><span id="detail-cumulative-label">包含下游 · ${(session.total === 0 ? 0 : detailHotspot.cumulative / session.total * 100).toFixed(1)}%</span></div>
  </div>` : ''}
  ${!graph && session.total !== 0
    ? '<div class="notice">Graphviz 不可用，已回退到瓶颈排行和源码证据。安装 dot 后可查看调用图。</div>'
    : ''}
  <div class="next-step">
    <strong>对比原始采样差异：</strong>
    ${baselineState === 'none' ? '<button class="secondary" data-action="baseline">设为修改前基线</button>' : ''}
    ${baselineState === 'available' ? '<button data-action="compare">与基线比较</button>' : ''}
    <button class="secondary" data-action="recapture">重新采集</button>
  </div>
  <div class="tabs">${graph ? '<button class="active" data-tab="graph">调用图</button>' : ''}<button class="${graph ? '' : 'active'}" data-tab="top">函数排行</button><button data-tab="source">源码行</button></div>
  ${graph ? `<section id="graph" class="active"><div class="toolbar"><span class="hint">自身 = 直接发生在函数内；包含下游 = 连同它调用的函数。点击节点跳到源码并查看详情。</span></div><div class="graph-wrap">${graph.svg}</div></section>` : ''}
  <section id="top" class="${graph ? '' : 'active'}"><div class="toolbar"><input id="top-filter" placeholder="筛选函数或源码路径"><label class="hint"><input id="hide-runtime" type="checkbox" checked> 隐藏 Go 运行时</label></div><table><thead><tr><th>函数</th><th>自身</th><th>包含下游</th><th>源码</th></tr></thead><tbody>
    ${session.hotspots.length === 0
      ? `<tr><td colspan="4"><div class="notice">本次没有采集到 ${escapeHtml(profileMetricLabel(session.sampleType))} 样本。采集 CPU 时需要在采集期间实际触发业务操作。</div></td></tr>`
      : session.hotspots.slice(0, 100).map((hotspot) => `<tr class="source-row top-row${focusedHotspot?.id === hotspot.id ? ' focused' : ''}" data-runtime="${isRuntimeHotspot(hotspot)}" data-filter="${escapeHtml(`${hotspot.name} ${hotspot.location?.file ?? ''}`.toLowerCase())}" data-file="${escapeHtml(hotspot.location?.file ?? '')}" data-line="${hotspot.location?.line ?? 0}" data-name="${escapeHtml(hotspot.name)}" data-self="${escapeHtml(formatValue(hotspot.flat, session.sampleUnit))}" data-self-percent="${(session.total === 0 ? 0 : hotspot.flat / session.total * 100).toFixed(1)}" data-cumulative="${escapeHtml(formatValue(hotspot.cumulative, session.sampleUnit))}" data-cumulative-percent="${(session.total === 0 ? 0 : hotspot.cumulative / session.total * 100).toFixed(1)}">
      <td>${escapeHtml(hotspot.name)}</td><td>${formatValue(hotspot.flat, session.sampleUnit)}</td><td>${formatValue(hotspot.cumulative, session.sampleUnit)}</td>
      <td>${escapeHtml(hotspot.location ? `${hotspot.location.file}:${hotspot.location.line}` : '')}</td></tr>`).join('')}
  </tbody></table></section>
  <section id="source"><table><thead><tr><th>源码行</th><th>函数</th><th>自身</th><th>包含下游</th><th>占总量</th></tr></thead><tbody>
    ${[...session.lineMetrics].sort((left, right) => right.value - left.value).slice(0, 200).map((metric) => {
      const percent = session.total === 0 ? 0 : metric.value / session.total * 100;
      return `<tr class="source-row source-metric" data-runtime="${isRuntimeLine(metric)}" data-file="${escapeHtml(metric.file)}" data-line="${metric.line}"><td>${escapeHtml(`${metric.file}:${metric.line}`)}</td><td>${escapeHtml(metric.functionName)}</td><td>${metric.flat === undefined ? '—' : formatValue(metric.flat, session.sampleUnit)}</td><td>${formatValue(metric.value, session.sampleUnit)}</td><td>${percent.toFixed(1)}%</td></tr>`;
    }).join('')}
  </tbody></table></section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const graphDetails = ${JSON.stringify(graphDetails).replaceAll('<', '\\u003c')};
    const renderDetail = detail => {
      if (!detail || !document.getElementById('detail-name')) return;
      document.getElementById('detail-name').textContent = detail.name;
      document.getElementById('detail-source').textContent = detail.source;
      document.getElementById('detail-self').textContent = detail.self;
      document.getElementById('detail-self-label').textContent = '自身 · ' + detail.selfPercent + '%';
      document.getElementById('detail-cumulative').textContent = detail.cumulative;
      document.getElementById('detail-cumulative-label').textContent = '包含下游 · ' + detail.cumulativePercent + '%';
    };
    document.querySelectorAll('.tabs button').forEach(button => button.addEventListener('click', () => {
      document.querySelectorAll('.tabs button,section').forEach(element => element.classList.remove('active'));
      button.classList.add('active'); document.getElementById(button.dataset.tab).classList.add('active');
    }));
    document.querySelectorAll('[data-tab-target]').forEach(button => button.addEventListener('click', () => {
      document.querySelector('[data-tab="' + button.dataset.tabTarget + '"]')?.click();
    }));
    document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
      vscode.postMessage({command:'action',action:button.dataset.action});
    }));
    const topFilter = document.getElementById('top-filter');
    const hideRuntime = document.getElementById('hide-runtime');
    const focusedFunction = ${JSON.stringify(focusedHotspot?.name ?? '').replaceAll('<', '\\u003c')};
    if (focusedFunction) {
      topFilter.value = focusedFunction;
      hideRuntime.checked = false;
    }
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
    document.querySelector('.top-row.focused')?.scrollIntoView({block:'center'});
    document.addEventListener('click', event => {
      const graphNode = event.target.closest('g.node[id^="gotune-node-"]');
      if (graphNode) {
        const index = Number(graphNode.id.slice('gotune-node-'.length));
        document.querySelectorAll('.profile-graph g.node.selected').forEach(node => node.classList.remove('selected'));
        graphNode.classList.add('selected');
        renderDetail(graphDetails[index]);
        vscode.postMessage({ command:'graph-source', index });
        return;
      }
      const target = event.target.closest('[data-file]');
      if (target?.classList.contains('top-row')) {
        renderDetail({
          name: target.dataset.name,
          source: target.dataset.file ? target.dataset.file + ':' + target.dataset.line : '没有源码位置',
          self: target.dataset.self,
          selfPercent: target.dataset.selfPercent,
          cumulative: target.dataset.cumulative,
          cumulativePercent: target.dataset.cumulativePercent
        });
      }
      if (target && target.dataset.file) vscode.postMessage({ command:'source', file:target.dataset.file, line:Number(target.dataset.line) });
    });
  </script>
</body>
</html>`;
  panel.webview.onDidReceiveMessage((message) => {
    if (
      message?.command === 'graph-source'
      && Number.isInteger(message.index)
      && graph?.locations[message.index]
    ) {
      const location = graph.locations[message.index];
      if (location) onOpenSource(location.file, location.line);
    } else if (message?.command === 'source' && typeof message.file === 'string' && typeof message.line === 'number') {
      onOpenSource(message.file, message.line);
    } else if (
      message?.command === 'action'
      && (message.action === 'escape' || message.action === 'baseline' || message.action === 'compare' || message.action === 'recapture')
    ) {
      onAction?.(message.action, actionHotspot);
    }
  });
}

function profileMetricLabel(sampleType: string): string {
  if (sampleType === 'cpu') return 'CPU 时间';
  if (sampleType === 'inuse_space') return '当前存活内存';
  if (sampleType === 'inuse_objects') return '当前存活对象';
  if (sampleType === 'alloc_space') return '累计分配内存';
  if (sampleType === 'alloc_objects') return '累计分配对象';
  if (/mutex/i.test(sampleType)) return '锁竞争等待';
  if (/block|delay|contentions/i.test(sampleType)) return '阻塞等待';
  if (/goroutine/i.test(sampleType)) return 'Goroutine';
  return sampleType;
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
  const unit = trend.sessions[0]?.sampleUnit ?? 'bytes';
  const metricLabel = unit === 'bytes' ? 'live heap' : 'live objects';
  const observation = growing.length > 0
    ? `${growing.length} 个源码映射分配点在这三次快照中的数值非递减。`
    : '没有源码映射分配点同时满足“首末为正差值且三次快照非递减”。';

  panel.webview.html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${nonce}">
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:18px}
    h1{font-size:18px;margin:0 0 4px}.summary{color:var(--vscode-descriptionForeground);margin-bottom:14px}
    .verdict{border-left:3px solid var(--vscode-charts-blue);background:var(--vscode-textBlockQuote-background);padding:11px 13px;margin-bottom:14px}
    .cards{display:grid;grid-template-columns:repeat(${trend.totals.length + 1},minmax(130px,1fr));gap:8px;margin-bottom:16px}.card{background:var(--vscode-editor-inactiveSelectionBackground);padding:10px 12px;border-radius:4px}.card strong{display:block;font-size:18px}.card span,.hint{font-size:12px;color:var(--vscode-descriptionForeground)}
    table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--vscode-panel-border)}.number{text-align:right;font-variant-numeric:tabular-nums}
    tr[data-file]:not([data-file=""]){cursor:pointer}tbody tr:hover{background:var(--vscode-list-hoverBackground)}.badge{display:inline-block;padding:2px 7px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:11px}
  </style>
</head>
<body>
  <h1>Memory Growth / 内存增长检测</h1>
  <div class="summary">三次快照均在强制 GC 后采集；这里展示 ${metricLabel} 的变化。</div>
  <div class="verdict"><b>采样观察：</b>${escapeHtml(observation)} 这不是内存泄漏结论；请结合更长时间窗口、对象数量和业务生命周期判断。</div>
  <div class="cards">
    ${trend.totals.map((total, index) => `<div class="card"><strong>${formatValue(total, unit)}</strong><span>${index === 0 ? 'Baseline' : `Round ${index}`} ${metricLabel}</span></div>`).join('')}
    <div class="card"><strong>${trend.totalGrowth > 0 ? '+' : ''}${formatValue(trend.totalGrowth, unit)}</strong><span>Total change</span></div>
  </div>
  <table>
    <thead><tr><th>源码映射函数</th>${trend.totals.map((_, index) => `<th class="number">${index === 0 ? 'Baseline' : `Round ${index}`}</th>`).join('')}<th class="number">首末差值</th><th>采样形态</th><th>源码</th></tr></thead>
    <tbody>
      ${[...trend.entries].sort((left, right) => Math.abs(right.growth) - Math.abs(left.growth)).slice(0, 100).map((entry) => {
        const source = entry.location ? `${entry.location.file}:${entry.location.line}` : '';
        return `<tr data-file="${escapeHtml(entry.location?.file ?? '')}" data-line="${entry.location?.line ?? 0}">
          <td>${escapeHtml(entry.name)}</td>
          ${entry.values.map((value) => `<td class="number">${formatValue(value, unit)}</td>`).join('')}
          <td class="number">${entry.growth > 0 ? '+' : ''}${formatValue(entry.growth, unit)}</td>
          <td>${entry.consistentlyGrowing ? '<span class="badge">三点非递减</span>' : '<span class="hint">有波动</span>'}</td>
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
  const increases = comparison.entries.filter((entry) => entry.delta > 0).length;
  const decreases = comparison.entries.filter((entry) => entry.delta < 0).length;
  const totalPercent = comparison.totalDeltaPercent === undefined
    ? 'new'
    : `${comparison.totalDeltaPercent > 0 ? '+' : ''}${comparison.totalDeltaPercent.toFixed(1)}%`;
  const topIncrease = comparison.entries.find((entry) =>
    entry.delta > 0 && entry.location && !isRuntimeFunction(entry.name, entry.location.file)
  );
  const comparisonSummary = comparison.totalDelta > 0
    ? `总量原始差值为 +${formatValue(comparison.totalDelta, current.sampleUnit)}。${topIncrease ? `源码映射项中增加最多的是 ${displayShortName(topIncrease.name)}（+${formatValue(topIncrease.delta, current.sampleUnit)}）。` : ''}`
    : comparison.totalDelta < 0
      ? `总量原始差值为 -${formatValue(Math.abs(comparison.totalDelta), current.sampleUnit)}。`
      : '总量原始差值为 0。';

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
    .toolbar{display:flex;gap:12px;align-items:center;margin-bottom:10px}.toolbar input{width:min(420px,65vw);padding:6px 8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}
    .toolbar label{font-size:12px;color:var(--vscode-descriptionForeground)}
    table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--vscode-panel-border)}
    tr[data-file]:not([data-file=""]){cursor:pointer}tbody tr:hover{background:var(--vscode-list-hoverBackground)}
    .number{text-align:right;font-variant-numeric:tabular-nums}
    .verdict{border-left:3px solid var(--vscode-charts-blue);background:var(--vscode-textBlockQuote-background);padding:10px 12px;margin-bottom:14px}.verdict[data-file]:not([data-file=""]){cursor:pointer}
    .warning{border-left:3px solid var(--vscode-editorWarning-foreground);background:var(--vscode-textBlockQuote-background);padding:8px 11px;margin-bottom:8px;color:var(--vscode-descriptionForeground)}
  </style>
</head>
<body>
  <h1>Profile comparison</h1>
  <div class="summary">${escapeHtml(baseline.name)} → ${escapeHtml(current.name)} · ${escapeHtml(current.sampleType)} (${escapeHtml(current.sampleUnit)})</div>
  ${comparison.warnings.map((warning) => `<div class="warning">⚠ ${escapeHtml(warning)}</div>`).join('')}
  <div class="verdict" data-file="${escapeHtml(topIncrease?.location?.file ?? '')}" data-line="${topIncrease?.location?.line ?? 0}"><b>原始差异：</b>${escapeHtml(comparisonSummary)}${topIncrease ? ' 点击打开源码。' : ''}<br><span class="summary">采样差异本身不代表性能改善或退化。</span></div>
  <div class="cards">
    <div class="card"><strong>${formatValue(baseline.total, baseline.sampleUnit)}</strong><span>Baseline total</span></div>
    <div class="card"><strong>${formatValue(current.total, current.sampleUnit)}</strong><span>Current total</span></div>
    <div class="card"><strong>${totalPercent}</strong><span>Total change</span></div>
    <div class="card"><strong>${increases} increased · ${decreases} decreased</strong><span>Non-zero function deltas</span></div>
  </div>
  <div class="toolbar"><input id="filter" placeholder="Filter functions or source paths"><label><input id="changed" type="checkbox" checked> Changed only</label><label><input id="runtime" type="checkbox" checked> Hide Go runtime</label></div>
  <table>
    <thead><tr><th>Function</th><th class="number">Before</th><th class="number">After</th><th class="number">Delta</th><th class="number">Change</th><th>Source</th></tr></thead>
    <tbody>
      ${comparison.entries.map((entry) => {
        const deltaText = `${entry.delta > 0 ? '+' : ''}${formatValue(entry.delta, current.sampleUnit)}`;
        const percent = entry.deltaPercent === undefined
          ? entry.after === 0 ? 'removed' : 'new'
          : `${entry.deltaPercent > 0 ? '+' : ''}${entry.deltaPercent.toFixed(1)}%`;
        const source = entry.location ? `${entry.location.file}:${entry.location.line}` : '';
        return `<tr data-changed="${entry.delta !== 0}" data-runtime="${isRuntimeFunction(entry.name, entry.location?.file)}" data-filter="${escapeHtml(`${entry.name} ${source}`.toLowerCase())}" data-file="${escapeHtml(entry.location?.file ?? '')}" data-line="${entry.location?.line ?? 0}">
          <td>${escapeHtml(entry.name)}</td><td class="number">${formatValue(entry.before, current.sampleUnit)}</td><td class="number">${formatValue(entry.after, current.sampleUnit)}</td>
          <td class="number">${deltaText}</td><td class="number">${percent}</td><td>${escapeHtml(source)}</td>
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
  const assessment = assessGoroutineSnapshot(snapshot);

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
    <div class="card"><strong>${snapshot.total}${snapshot.totalGrowth === 0 ? '' : ` (${snapshot.totalGrowth > 0 ? '+' : ''}${snapshot.totalGrowth})`}</strong><span>Application goroutines / growth since first sample</span></div>
    <div class="card"><strong>${snapshot.groups.length}</strong><span>Unique stack groups</span></div>
    <div class="card"><strong>${snapshot.stateCount}</strong><span>Runtime states</span></div>
    <div class="card"><strong>${watched}</strong><span>Blocking-state goroutines selected for review</span></div>
  </div>
  <div class="notice"><b>${escapeHtml(assessment.title)}</b><br>${escapeHtml(assessment.detail)}</div>
  <div class="toolbar">
    <input id="filter" placeholder="Filter state, function, or source">
    <select id="state"><option value="">All states</option>${states.map((state) => `<option value="${escapeHtml(state)}">${escapeHtml(state)}</option>`).join('')}</select>
    <label class="hint"><input id="hide-normal" type="checkbox" checked> Hide normal waits</label>
    <span class="hint">${watched} goroutine(s) selected by the blocking-state filter</span>
  </div>
  <table>
    <thead><tr><th class="number">Count</th><th class="number">Growth</th><th>State</th><th>Top frame</th><th>Stability</th><th>Assessment</th><th>Source</th></tr></thead>
    <tbody>
      ${snapshot.groups.map((group, index) => {
        const top = group.frames.find((frame) => frame.file) ?? group.frames[0];
        const source = top?.file ? `${top.file}:${top.line ?? 1}` : '';
        const filter = `${group.state} ${group.topFunction} ${source}`.toLowerCase();
        return `<tr class="group-row" data-index="${index}" data-state="${escapeHtml(group.state)}" data-severity="${group.severity}" data-filter="${escapeHtml(filter)}">
          <td class="number">${group.count}</td>
          <td class="number">${group.countGrowth === 0 ? '—' : `${group.countGrowth > 0 ? '+' : ''}${group.countGrowth}`}</td>
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
