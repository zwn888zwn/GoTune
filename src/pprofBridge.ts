export function pprofArguments(sampleType: string, profilePath: string): string[] {
  return [
    'tool',
    'pprof',
    '-http=127.0.0.1:',
    '-no_browser',
    `-sample_index=${sampleType}`,
    profilePath
  ];
}

export function pprofViewerUrl(output: string): string | undefined {
  return /\bhttps?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\S*/.exec(output)?.[0]
    .replace(/[),.;]+$/, '');
}

export function injectPprofBridge(html: string): string {
  const marker = '</body>';
  const script = `<script>${pprofBridgeScript()}</script>`;
  const index = html.lastIndexOf(marker);
  return index < 0 ? `${html}${script}` : `${html.slice(0, index)}${script}${html.slice(index)}`;
}

function pprofBridgeScript(): string {
  return String.raw`
(() => {
  const host = (message) => window.parent.postMessage({ source: 'gotune-pprof', ...message }, '*');
  const style = document.createElement('style');
  style.textContent = [
    '.header{display:none!important}',
    '*{scrollbar-width:thin;scrollbar-color:var(--gotune-muted,#6b7280) transparent}',
    '::-webkit-scrollbar{width:7px;height:7px}',
    '::-webkit-scrollbar-track{background:transparent}',
    '::-webkit-scrollbar-thumb{background:var(--gotune-muted,#6b7280);border-radius:7px}',
    '::-webkit-scrollbar-corner{background:transparent}',
    'html,body{background:var(--gotune-bg,#1e1e1e)!important;color:var(--gotune-fg,#cccccc)!important}',
    '#top,#content,#graph,#flamegraph{top:0!important}',
    '#graph{background-color:var(--gotune-bg,#1e1e1e)!important;background-image:linear-gradient(rgba(127,127,127,.10) 1px,transparent 1px),linear-gradient(90deg,rgba(127,127,127,.10) 1px,transparent 1px)!important;background-size:32px 32px!important}',
    '#graph svg{width:100%!important;height:100%!important;padding:20px!important}',
    '#graph svg>g.graph>polygon[fill="white"]{fill:var(--gotune-bg,#1e1e1e)!important}',
    '#graph g.edge text{fill:var(--gotune-fg,#cccccc)!important;font-family:system-ui,sans-serif!important}',
    '#graph g.edge path{stroke:var(--gotune-muted,#8b949e)!important;stroke-opacity:.72}',
    '#graph g.edge polygon{stroke:var(--gotune-muted,#8b949e)!important;fill:var(--gotune-muted,#8b949e)!important;fill-opacity:.82}',
    '#graph g.node text{fill:#f0f3f6!important;font-family:system-ui,sans-serif!important;font-weight:500}',
    '#graph g.node polygon{stroke-width:1.25px!important;filter:saturate(.62) brightness(.64) drop-shadow(0 3px 5px rgba(0,0,0,.38))}',
    '#graph g.node.gotune-target polygon{stroke:var(--gotune-selection,#4daafc)!important;stroke-width:4px!important;filter:drop-shadow(0 0 7px var(--gotune-selection,#4daafc))}',
    '#graph g.node.gotune-dim,#graph g.edge.gotune-dim{opacity:.16!important}',
    '#graph g.node.gotune-related polygon{stroke:var(--gotune-selection,#4daafc)!important;stroke-width:2px!important}',
    '#graph g.edge.gotune-related path{stroke:var(--gotune-selection,#4daafc)!important;stroke-width:2px!important;stroke-opacity:1!important}',
    '#graph g.edge.gotune-related polygon{stroke:var(--gotune-selection,#4daafc)!important;fill:var(--gotune-selection,#4daafc)!important}',
    '#graph g.node.gotune-search-match polygon{stroke:#f2cc60!important;stroke-width:3px!important}',
    '#stack-holder,#current-details{background:var(--gotune-bg,#1e1e1e)!important;color:var(--gotune-fg,#cccccc)!important}',
    '#stack-chart{background-image:linear-gradient(var(--gotune-border,#343b43) 1px,transparent 1px);background-size:100% 20px}',
    '.boxbg{border-right:1px solid var(--gotune-bg,#1e1e1e)!important;border-top-color:rgba(255,255,255,.24)!important;filter:saturate(1.2) brightness(.72)}',
    '.boxtext{color:#fff!important;font-family:system-ui,sans-serif!important;font-size:12px!important;font-weight:500;text-shadow:0 1px 1px rgba(0,0,0,.55)}',
    '.separator{color:var(--gotune-fg,#cccccc)!important}',
    '.boxbg.hilite,.boxbg.hilite2{box-shadow:inset 0 0 0 2px var(--gotune-selection,#4daafc),0 0 6px var(--gotune-selection,#4daafc)!important;filter:saturate(1.35) brightness(.9)}',
    '.boxbg.gotune-flame-match{box-shadow:inset 0 0 0 2px #f2cc60!important;filter:saturate(1.3) brightness(.88)}',
    '.boxbg.gotune-flame-current{box-shadow:inset 0 0 0 3px var(--gotune-selection,#4daafc),0 0 7px var(--gotune-selection,#4daafc)!important;filter:saturate(1.35) brightness(.95)}',
    '#toptable th{background:var(--gotune-header,#252526)!important;color:var(--gotune-fg,#cccccc)!important}',
    '#toptable td,#toptable th{border-color:var(--gotune-border,#3c3c3c)!important}',
    '#toptable tr:hover td{background:var(--gotune-hover,#2a2d2e)!important}',
    '#toptable th.gotune-sortable{cursor:pointer;user-select:none}',
    '#toptable th.gotune-sortable:hover{background:var(--gotune-hover,#2a2d2e)!important}',
    '#gotune-flame-tooltip{position:fixed;z-index:10000;width:300px;padding:10px 11px;border:1px solid var(--gotune-border,#3c3c3c);border-radius:6px;background:var(--gotune-header,#252526);color:var(--gotune-fg,#cccccc);box-shadow:0 5px 18px rgba(0,0,0,.42);font:12px/1.45 system-ui,sans-serif;pointer-events:none}',
    '.gotune-tooltip-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;margin-bottom:8px}',
    '.gotune-tooltip-metric{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:9px}',
    '.gotune-tooltip-track{height:6px;overflow:hidden;border-radius:6px;background:var(--gotune-border,#3c3c3c)}',
    '.gotune-tooltip-fill{height:100%;border-radius:6px;background:var(--gotune-selection,#4daafc)}',
    '.gotune-tooltip-value{font-variant-numeric:tabular-nums;color:var(--gotune-fg,#cccccc)}',
    '.gotune-tooltip-detail{margin-top:6px;color:var(--gotune-muted,#8b949e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.menu-delete-btn,.menu-check-mark{color:var(--gotune-fg,#cccccc)!important}'
  ].join('');
  document.head.appendChild(style);
  const metricValue = (text) => {
    const value = Number.parseFloat(String(text).replace(/,/g, ''));
    if (!Number.isFinite(value)) return undefined;
    const unit = String(text).match(/\b([kmgt]?i?b|ns|us|µs|ms|s|%)\b/i)?.[1]?.toLowerCase();
    const scale = unit === 'kib' || unit === 'kb' ? 1024
      : unit === 'mib' || unit === 'mb' ? 1024 ** 2
        : unit === 'gib' || unit === 'gb' ? 1024 ** 3
          : unit === 'tib' || unit === 'tb' ? 1024 ** 4
            : unit === 'us' || unit === 'µs' ? 1e3
              : unit === 'ms' ? 1e6 : unit === 's' ? 1e9 : 1;
    return value * scale;
  };
  const installTopSorting = () => {
    const table = document.getElementById('toptable');
    const header = table?.querySelector('tr');
    if (!table || !header) return;
    [...header.children].forEach((cell, column) => {
      if (/^sum%$/i.test(cell.textContent.trim())) return;
      if (cell.dataset.gotuneSort) return;
      cell.dataset.gotuneSort = 'ready';
      cell.classList.add('gotune-sortable');
      cell.addEventListener('click', () => {
        const ascending = cell.dataset.direction
          ? cell.dataset.direction !== 'asc'
          : !/flat|cum/i.test(cell.textContent);
        for (const sibling of header.children) {
          delete sibling.dataset.direction;
          sibling.textContent = sibling.textContent.replace(/\s+[▲▼]$/, '');
        }
        cell.dataset.direction = ascending ? 'asc' : 'desc';
        cell.textContent += ascending ? ' ▲' : ' ▼';
        const rows = [...table.querySelectorAll('tr')].slice(1);
        rows.sort((left, right) => {
          const a = left.children[column]?.textContent?.trim() || '';
          const b = right.children[column]?.textContent?.trim() || '';
          const an = metricValue(a);
          const bn = metricValue(b);
          const compared = an !== undefined && bn !== undefined
            ? an - bn : a.localeCompare(b, undefined, { numeric: true });
          return ascending ? compared : -compared;
        });
        const parent = rows[0]?.parentElement;
        if (parent) rows.forEach((row) => parent.appendChild(row));
        const headers = [...header.children].map((item) => item.textContent.trim().toLowerCase());
        const flatPercentColumn = headers.findIndex((item) => item.startsWith('flat%'));
        const sumPercentColumn = headers.findIndex((item) => item.startsWith('sum%'));
        if (flatPercentColumn >= 0 && sumPercentColumn >= 0) {
          let sum = 0;
          for (const row of rows) {
            sum += Number.parseFloat(row.children[flatPercentColumn]?.textContent || '0') || 0;
            row.children[sumPercentColumn].textContent = Math.min(100, sum).toFixed(2) + '%';
          }
        }
      });
    });
  };
  const flameTooltip = document.createElement('div');
  flameTooltip.id = 'gotune-flame-tooltip';
  flameTooltip.hidden = true;
  document.body.appendChild(flameTooltip);
  document.addEventListener('mousemove', (event) => {
    const box = event.target.closest?.('.boxbg');
    if (!box) {
      flameTooltip.hidden = true;
      return;
    }
    if (box.title) {
      box.dataset.gotuneTitle = box.title;
      box.removeAttribute('title');
    }
    const name = flameFunction(box);
    const details = box.dataset.gotuneTitle
      || document.getElementById('current-details-right')?.textContent || '';
    const percentage = Math.max(0, Math.min(100, Number(
      /\(([\d.]+)%\)/.exec(details)?.[1] || 0
    )));
    const measured = details.split('|')[0]?.trim() || '';
    flameTooltip.replaceChildren();
    const title = document.createElement('div');
    title.className = 'gotune-tooltip-name';
    title.textContent = name;
    const metric = document.createElement('div');
    metric.className = 'gotune-tooltip-metric';
    const track = document.createElement('div');
    track.className = 'gotune-tooltip-track';
    const fill = document.createElement('div');
    fill.className = 'gotune-tooltip-fill';
    fill.style.width = percentage + '%';
    track.appendChild(fill);
    const value = document.createElement('span');
    value.className = 'gotune-tooltip-value';
    value.textContent = percentage.toFixed(2) + '%';
    metric.append(track, value);
    const detail = document.createElement('div');
    detail.className = 'gotune-tooltip-detail';
    detail.textContent = measured.replace(/\s*\([\d.]+%\)\s*$/, '');
    flameTooltip.append(title, metric, detail);
    flameTooltip.hidden = false;
    flameTooltip.style.left = Math.max(8, Math.min(event.clientX + 14, innerWidth - 320)) + 'px';
    flameTooltip.style.top = Math.max(8, Math.min(event.clientY + 14, innerHeight - 120)) + 'px';
  }, true);
  const graphFunction = (target) => {
    const node = target.closest?.('g.node');
    if (!node) return '';
    const title = node.querySelector('a')?.getAttribute('xlink:title')
      || node.querySelector('a')?.getAttribute('title')
      || node.querySelector('title')?.textContent || '';
    return title.replace(/\s+\([^)]*\)\s*$/, '').trim();
  };
  let initialGraphViewBox;
  let graphDragEndedAt = 0;
  let graphClickTimer;
  const graphSvg = () => document.querySelector('#graph svg');
  const installGraphPan = (svg) => {
    if (!svg || svg.dataset.gotunePan) return;
    svg.dataset.gotunePan = 'ready';
    svg.style.cursor = 'grab';
    svg.style.touchAction = 'none';
    let drag;
    const pointerDown = (event) => {
      if (!event.target.closest?.('#graph') || event.button < 0 || event.button > 2) return;
      const view = svg.viewBox.baseVal;
      drag = {
        x: event.clientX,
        y: event.clientY,
        viewX: view.x,
        viewY: view.y,
        width: view.width,
        height: view.height,
        moved: false
      };
      svg.setPointerCapture(event.pointerId);
      svg.style.cursor = 'grabbing';
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const pointerMove = (event) => {
      if (!drag) return;
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 3) {
        drag.moved = true;
      }
      const view = svg.viewBox.baseVal;
      view.x = drag.viewX - (event.clientX - drag.x) * drag.width / Math.max(1, svg.clientWidth);
      view.y = drag.viewY - (event.clientY - drag.y) * drag.height / Math.max(1, svg.clientHeight);
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const stop = (event) => {
      if (!drag) return;
      if (drag.moved) graphDragEndedAt = Date.now();
      drag = undefined;
      svg.style.cursor = 'grab';
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const wheel = (event) => {
      if (!event.target.closest?.('#graph')) return;
      const view = svg.viewBox.baseVal;
      const modeScale = event.deltaMode === 1 ? 16
        : event.deltaMode === 2 ? Math.max(1, svg.clientHeight) : 1;
      let deltaX = event.deltaX * modeScale;
      let deltaY = event.deltaY * modeScale;
      if (event.shiftKey && deltaX === 0) {
        deltaX = deltaY;
        deltaY = 0;
      }
      if (event.ctrlKey || event.metaKey) {
        const point = svg.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        const screenMatrix = svg.getScreenCTM();
        const anchor = screenMatrix ? point.matrixTransform(screenMatrix.inverse()) : {
          x: view.x + view.width / 2,
          y: view.y + view.height / 2
        };
        const requested = Math.exp(Math.max(-100, Math.min(100, deltaY)) * .0015);
        const initial = initialGraphViewBox || { width: view.width };
        const nextWidth = Math.max(initial.width * .03, Math.min(initial.width * 4, view.width * requested));
        const factor = nextWidth / view.width;
        view.x = anchor.x - (anchor.x - view.x) * factor;
        view.y = anchor.y - (anchor.y - view.y) * factor;
        view.width *= factor;
        view.height *= factor;
      } else {
        view.x += deltaX * 1.35 * view.width / Math.max(1, svg.clientWidth);
        view.y += deltaY * view.height / Math.max(1, svg.clientHeight);
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('pointerdown', pointerDown, true);
    window.addEventListener('pointermove', pointerMove, true);
    window.addEventListener('pointerup', stop, true);
    window.addEventListener('pointercancel', stop, true);
    window.addEventListener('wheel', wheel, { capture: true, passive: false });
    svg.addEventListener('contextmenu', (event) => event.preventDefault());
  };
  const rememberGraphViewBox = () => {
    const svg = graphSvg();
    if (!svg || initialGraphViewBox) return;
    installGraphPan(svg);
    const box = svg.viewBox.baseVal;
    initialGraphViewBox = { x: box.x, y: box.y, width: box.width, height: box.height };
    for (const text of svg.querySelectorAll('g.node text')) {
      const size = Number(text.getAttribute('font-size'));
      if (Number.isFinite(size) && size < 10) text.setAttribute('font-size', '10');
    }
  };
  const graphNodeFor = (functionName) => {
    const normalize = (value) => String(value || '')
      .replace(/\s*\(inlined\)\s*$/, '')
      .replace(/\s+/g, '')
      .trim();
    const normalized = normalize(functionName);
    const shortName = normalized.split('/').at(-1);
    const nodes = [...document.querySelectorAll('#graph g.node')];
    const exact = nodes.find((node) => normalize(graphFunction(node)) === normalized);
    if (exact) return exact;
    const matches = nodes.filter((node) => {
      const candidate = normalize(graphFunction(node));
      const candidateShort = candidate.split('/').at(-1);
      return candidate.endsWith('.' + normalized)
        || normalized.endsWith('.' + candidate)
        || candidateShort === shortName;
    });
    return matches.length === 1 ? matches[0] : undefined;
  };
  const graphNodeKey = (node) => node?.querySelector(':scope > title')?.textContent?.trim() || '';
  const clearGraphFocus = () => {
    document.querySelectorAll('#graph g.node,#graph g.edge').forEach((item) => {
      item.classList.remove('gotune-target', 'gotune-related', 'gotune-dim');
    });
  };
  const focusGraphNode = (node) => {
    if (!node) return false;
    clearGraphFocus();
    const key = graphNodeKey(node);
    const relatedKeys = new Set([key]);
    const relatedEdges = new Set();
    if (key) {
      for (const edge of document.querySelectorAll('#graph g.edge')) {
        const title = edge.querySelector(':scope > title')?.textContent?.trim() || '';
        const parts = title.split('->').map((part) => part.trim());
        if (parts.length === 2 && parts.includes(key)) {
          relatedKeys.add(parts[0]);
          relatedKeys.add(parts[1]);
          relatedEdges.add(edge);
        }
      }
    }
    for (const candidate of document.querySelectorAll('#graph g.node')) {
      const related = candidate === node || relatedKeys.has(graphNodeKey(candidate));
      candidate.classList.toggle('gotune-dim', !related);
      candidate.classList.toggle('gotune-related', related && candidate !== node);
    }
    for (const edge of document.querySelectorAll('#graph g.edge')) {
      edge.classList.toggle('gotune-related', relatedEdges.has(edge));
      edge.classList.toggle('gotune-dim', !relatedEdges.has(edge));
    }
    node.classList.add('gotune-target');
    centerGraphNode(graphFunction(node));
    return true;
  };
  const compileSearch = (query) => {
    if (!query) return undefined;
    try {
      return new RegExp(query, 'i');
    } catch {
      const escaped = String(query).replace(/([\\.?+*\[\](){}|^$])/g, '\\$1');
      return new RegExp(escaped, 'i');
    }
  };
  const searchGraph = (query) => {
    const expression = compileSearch(String(query || '').trim());
    const results = [];
    document.querySelectorAll('#graph g.node.gotune-search-match')
      .forEach((item) => item.classList.remove('gotune-search-match'));
    if (expression) {
      for (const node of document.querySelectorAll('#graph g.node')) {
        const name = graphFunction(node);
        if (name && expression.test(name)) {
          node.classList.add('gotune-search-match');
          if (!results.includes(name)) results.push(name);
        }
      }
    }
    host({ command: 'search-results', view: 'graph', query: String(query || ''), results });
    return results;
  };
  const graphControl = (action) => {
    const svg = graphSvg();
    if (!svg) return;
    rememberGraphViewBox();
    const box = svg.viewBox.baseVal;
    if (action === 'fit' && initialGraphViewBox) {
      clearGraphFocus();
      box.x = initialGraphViewBox.x;
      box.y = initialGraphViewBox.y;
      box.width = initialGraphViewBox.width;
      box.height = initialGraphViewBox.height;
      return;
    }
    const factor = action === 'zoom-in' ? 0.88 : action === 'zoom-out' ? 1.14 : 1;
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    box.width *= factor;
    box.height *= factor;
    box.x = centerX - box.width / 2;
    box.y = centerY - box.height / 2;
  };
  const centerGraphNode = (functionName) => {
    const svg = graphSvg();
    const node = graphNodeFor(functionName);
    if (!svg || !node) return false;
    rememberGraphViewBox();
    document.querySelectorAll('#graph g.node.gotune-target')
      .forEach((item) => item.classList.remove('gotune-target'));
    node.classList.add('gotune-target');
    const screenMatrix = svg.getScreenCTM();
    if (!screenMatrix) return true;
    const inverse = screenMatrix.inverse();
    const bounds = node.getBoundingClientRect();
    const point = svg.createSVGPoint();
    point.x = bounds.left + bounds.width / 2;
    point.y = bounds.top + bounds.height / 2;
    const center = point.matrixTransform(inverse);
    point.x = bounds.left;
    const left = point.matrixTransform(inverse);
    point.x = bounds.right;
    const right = point.matrixTransform(inverse);
    const nodeWidth = Math.abs(right.x - left.x);
    const view = svg.viewBox.baseVal;
    const initial = initialGraphViewBox || { width: view.width, height: view.height };
    const width = Math.min(initial.width, Math.max(nodeWidth * 5, initial.width * 0.22));
    const aspect = Math.max(0.4, svg.clientWidth / Math.max(1, svg.clientHeight));
    const height = Math.min(initial.height, width / aspect);
    view.x = center.x - width / 2;
    view.y = center.y - height / 2;
    view.width = width;
    view.height = height;
    return true;
  };
  const topFunction = (target) => {
    const row = target.closest?.('#toptable tr');
    return row?.children?.[5]?.textContent?.trim() || '';
  };
  const flameFunction = (target) => {
    const box = target.closest?.('.boxbg');
    if (!box) return '';
    const detail = box.dataset.gotuneTitle
      || box.title || document.getElementById('current-details-left')?.textContent || '';
    const name = detail.includes('│') ? detail.split('│').at(-1) : detail;
    return name.replace(/\s*\(inlined\)\s*$/, '').trim();
  };
  let flameMatches = [];
  let flameMatchIndex = -1;
  const revealFlameMatch = (index) => {
    document.querySelectorAll('.boxbg.gotune-flame-current')
      .forEach((item) => item.classList.remove('gotune-flame-current'));
    if (flameMatches.length === 0) {
      flameMatchIndex = -1;
    } else {
      flameMatchIndex = (index + flameMatches.length) % flameMatches.length;
      const match = flameMatches[flameMatchIndex];
      match.classList.add('gotune-flame-current');
      match.scrollIntoView({ block: 'center', inline: 'center' });
    }
    host({
      command: 'search-position',
      view: 'flame',
      index: flameMatchIndex,
      total: flameMatches.length
    });
  };
  const searchFlame = (query) => {
    const expression = compileSearch(String(query || '').trim());
    document.querySelectorAll('.boxbg.gotune-flame-match,.boxbg.gotune-flame-current')
      .forEach((item) => item.classList.remove('gotune-flame-match', 'gotune-flame-current'));
    flameMatches = expression
      ? [...document.querySelectorAll('.boxbg')].filter((box) => expression.test(flameFunction(box)))
      : [];
    flameMatches.forEach((box) => box.classList.add('gotune-flame-match'));
    revealFlameMatch(flameMatches.length > 0 ? 0 : -1);
    host({
      command: 'search-results',
      view: 'flame',
      query: String(query || ''),
      results: flameMatches.map((box) => flameFunction(box))
    });
  };
  const setFlamePivot = (functionName) => {
    const url = new URL(document.URL);
    const name = String(functionName || '').replace(/\s*\(inlined\)\s*$/, '').trim();
    if (name) {
      const escaped = name.replace(/([\\.?+*\[\](){}|^$])/g, '\\$1');
      url.searchParams.set('p', '^' + escaped + '$');
    } else {
      url.searchParams.delete('p');
    }
    history.pushState('', '', url.toString());
    flameMatches = [];
    flameMatchIndex = -1;
    window.dispatchEvent(new PopStateEvent('popstate'));
    host({
      command: 'search-position',
      view: 'flame',
      index: -1,
      total: 0
    });
  };
  const sourceLocation = (target) => {
    const source = target.closest?.('#content.source span.livesrc, #content.source span.nop');
    if (source) {
      const line = Number(source.previousElementSibling?.textContent?.trim());
      const pre = source.closest('pre');
      const file = pre?.previousElementSibling?.classList?.contains('filename')
        ? pre.previousElementSibling.textContent.trim() : '';
      if (file && Number.isInteger(line)) return { file, line };
    }
    const selection = window.getSelection();
    const node = selection?.focusNode;
    const pre = node?.parentElement?.closest?.('pre') || (node?.parentElement?.tagName === 'PRE' ? node.parentElement : null);
    if (!node || !pre) return undefined;
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let offset = 0;
    while (walker.nextNode()) {
      if (walker.currentNode === node) {
        offset += selection.focusOffset;
        break;
      }
      offset += walker.currentNode.textContent.length;
    }
    const text = pre.textContent;
    const start = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const end = text.indexOf('\n', offset);
    const lineText = text.slice(start, end < 0 ? text.length : end);
    const match = /(?:^|\|)\s*\\S.*?\s+((?:[A-Za-z]:)?[^\\s]+\\.go):(\\d+)/.exec(lineText);
    return match ? { file: match[1], line: Number(match[2]) } : undefined;
  };
  const functionAt = (target) => topFunction(target) || graphFunction(target) || flameFunction(target);
  document.addEventListener('click', (event) => {
    if (Date.now() - graphDragEndedAt < 100) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const graphNode = event.target.closest?.('#graph g.node');
    if (graphNode) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const functionName = graphFunction(graphNode);
      if (!functionName) return;
      clearTimeout(graphClickTimer);
      graphClickTimer = setTimeout(() => {
        focusGraphNode(graphNode);
        host({ command: 'selected-function', functionName });
      }, 180);
      return;
    }
    if (event.target.closest?.('#graph svg')) {
      clearGraphFocus();
      return;
    }
    const functionName = functionAt(event.target);
    if (!functionName) return;
    host({ command: 'selected-function', functionName });
    if (topFunction(event.target)) host({ command: 'open-function', functionName });
  }, true);
  document.addEventListener('dblclick', (event) => {
    const location = sourceLocation(event.target);
    if (location) {
      host({ command: 'open-source', ...location });
      return;
    }
    const flameName = flameFunction(event.target);
    if (flameName) {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        host({ command: 'open-function', functionName: flameName });
      }
      return;
    }
    if (topFunction(event.target)) return;
    const functionName = graphFunction(event.target);
    if (functionName) {
      event.preventDefault();
      event.stopImmediatePropagation();
      clearTimeout(graphClickTimer);
      host({ command: 'open-function', functionName });
    }
  }, true);
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.source !== 'gotune-host') return;
    if (message.command === 'theme') {
      const root = document.documentElement.style;
      for (const [key, value] of Object.entries(message.colors || {})) {
        root.setProperty('--gotune-' + key, String(value));
      }
      rememberGraphViewBox();
      return;
    }
    if (message.command === 'graph-control') {
      graphControl(message.action);
      return;
    }
    if (message.command === 'search-step') {
      if (flameMatches.length > 0) {
        revealFlameMatch(flameMatchIndex + Number(message.delta || 1));
      }
      return;
    }
    if (message.command === 'flame-reset') {
      setFlamePivot('');
      return;
    }
    if (message.command === 'focus-function' || message.command === 'search') {
      if (message.command === 'focus-function' && graphSvg()) {
        const delays = [50, 200, 500, 1000];
        delays.forEach((delay, index) => setTimeout(() => {
          const node = graphNodeFor(message.functionName);
          if (node && focusGraphNode(node)) return;
          if (index === delays.length - 1) {
            host({ command: 'focus-missed', functionName: message.functionName });
          }
        }, delay));
        return;
      }
      if (graphSvg()) {
        searchGraph(message.command === 'focus-function' ? message.functionName : message.query);
        return;
      }
      if (document.querySelector('#flamegraph,.boxbg')) {
        if (message.command === 'focus-function') {
          setFlamePivot(message.functionName);
        } else {
          searchFlame(message.query);
        }
        return;
      }
      const search = document.getElementById('search');
      if (!search) return;
      search.value = message.command === 'focus-function'
        ? '^' + message.functionName.replace(/([\\.?+*\[\](){}|^$])/g, '\\$1') + '$'
        : String(message.query || '');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      if (message.command === 'focus-function') search.focus();
      setTimeout(() => {
        document.querySelector('.hilite, .hilite2')?.scrollIntoView({
          block: 'center',
          inline: 'center'
        });
      }, 400);
    }
  });
  rememberGraphViewBox();
  installTopSorting();
  host({ command: 'ready', path: location.pathname, search: location.search });
})();`;
}
