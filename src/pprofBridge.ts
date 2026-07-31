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
    'html,body{background:var(--gotune-bg,#1e1e1e)!important;color:var(--gotune-fg,#cccccc)!important}',
    '#top,#content,#graph,#flamegraph{top:0!important}',
    '#toptable th{background:var(--gotune-header,#252526)!important;color:var(--gotune-fg,#cccccc)!important}',
    '#toptable td,#toptable th{border-color:var(--gotune-border,#3c3c3c)!important}',
    '#toptable tr:hover td{background:var(--gotune-hover,#2a2d2e)!important}',
    '.menu-delete-btn,.menu-check-mark{color:var(--gotune-fg,#cccccc)!important}'
  ].join('');
  document.head.appendChild(style);
  const graphFunction = (target) => {
    const node = target.closest?.('g.node');
    if (!node) return '';
    const title = node.querySelector('a')?.getAttribute('xlink:title')
      || node.querySelector('a')?.getAttribute('title') || '';
    return title.replace(/\s+\([^)]*\)\s*$/, '').trim();
  };
  const topFunction = (target) => {
    const row = target.closest?.('#toptable tr');
    return row?.children?.[5]?.textContent?.trim() || '';
  };
  const flameFunction = (target) => {
    const box = target.closest?.('.boxbg');
    if (!box) return '';
    const detail = box.title || document.getElementById('current-details-left')?.textContent || '';
    const name = detail.includes('│') ? detail.split('│').at(-1) : detail;
    return name.replace(/\s*\(inlined\)\s*$/, '').trim();
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
    const functionName = functionAt(event.target);
    if (functionName) host({ command: 'selected-function', functionName });
  }, true);
  document.addEventListener('dblclick', (event) => {
    const location = sourceLocation(event.target);
    if (location) {
      host({ command: 'open-source', ...location });
      return;
    }
    const functionName = functionAt(event.target);
    if (functionName) host({ command: 'open-function', functionName });
  }, true);
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.source !== 'gotune-host') return;
    if (message.command === 'theme') {
      const root = document.documentElement.style;
      for (const [key, value] of Object.entries(message.colors || {})) {
        root.setProperty('--gotune-' + key, String(value));
      }
      return;
    }
    if (message.command === 'focus-function' || message.command === 'search') {
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
  host({ command: 'ready', path: location.pathname, search: location.search });
})();`;
}
