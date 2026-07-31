import { ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { ProfileSession } from './model';
import { injectPprofBridge, pprofArguments, pprofViewerUrl } from './pprofBridge';
import { listProfileSampleTypes } from './profileParser';
import { profileTreeRows } from './profileTree';
import { shouldCreateProcessGroup, signalProcessTree } from './processTree';

const execFileAsync = promisify(execFile);

interface Output {
  append(value: string): void;
  appendLine(value: string): void;
}

interface OpenOptions {
  session: ProfileSession;
  goExecutable: string;
  environment: Record<string, string>;
  focusedFunction?: string;
  onOpenFunction(functionName: string): void;
  onOpenSource(file: string, line: number): void;
  onLocateCurrentFunction(): Promise<string | undefined>;
  onChangeSampleType(sampleType: string, bytes: Buffer): Promise<ProfileSession | undefined>;
}

type ProfileView = 'top' | 'graph' | 'flame' | 'tree' | 'peek' | 'source';

export class PprofViewer implements vscode.Disposable, vscode.WebviewViewProvider {
  private readonly artifacts = new Map<string, Buffer>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private proxy: http.Server | undefined;
  private temporaryDirectory: string | undefined;
  private view: vscode.WebviewView | undefined;
  private activeSessionId: string | undefined;
  private activeView: ProfileView = 'graph';
  private proxyUrl: string | undefined;
  private graphvizAvailable = true;
  private graphNodeCount = 80;
  private graphNodeFraction = 0.005;
  private graphEdgeFraction = 0.001;
  private graphCallTree = false;
  private options: OpenOptions | undefined;
  private selectedFunction = '';

  constructor(private readonly output: Output) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message) => void this.handleMessage(message));
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    this.render();
  }

  registerProfile(sessionIds: string | string[], bytes: Buffer): void {
    const artifact = Buffer.from(bytes);
    for (const sessionId of Array.isArray(sessionIds) ? sessionIds : [sessionIds]) {
      this.artifacts.set(sessionId, artifact);
    }
  }

  hasProfile(sessionId: string): boolean {
    return this.artifacts.has(sessionId);
  }

  async open(options: OpenOptions): Promise<void> {
    const artifact = this.artifacts.get(options.session.id);
    if (!artifact) {
      throw new Error('原始 Profile 只在本次 VS Code 运行中保留，请重新采集或导入后再打开。');
    }
    const changingProfile = this.options?.session.source !== options.session.source;
    this.options = options;
    if (options.focusedFunction) {
      this.selectedFunction = options.focusedFunction;
    } else if (changingProfile) {
      this.selectedFunction = '';
    }
    if (this.activeSessionId !== options.session.id || !this.child || !this.proxyUrl) {
      await this.start(options, artifact);
    }
    await vscode.commands.executeCommand('workbench.view.extension.gotuneOptimization');
    this.view?.show(true);
    this.render();
  }

  async clear(): Promise<void> {
    this.artifacts.clear();
    this.options = undefined;
    await this.stopCurrent();
    this.render();
  }

  dispose(): void {
    this.artifacts.clear();
    this.options = undefined;
    void this.stopCurrent();
  }

  private async start(options: OpenOptions, artifact: Buffer): Promise<void> {
    await this.stopCurrent();
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gotune-pprof-'));
    this.temporaryDirectory = temporaryDirectory;
    const profilePath = path.join(temporaryDirectory, 'profile.pb.gz');
    await fs.writeFile(profilePath, artifact, { mode: 0o600 });

    const args = pprofArguments(options.session.sampleType, profilePath);
    this.output.appendLine(`[GoTune] Opening official pprof UI: ${options.goExecutable} ${args.join(' ')}`);
    const child = spawn(options.goExecutable, args, {
      env: {
        ...process.env,
        ...options.environment,
        ...(process.platform === 'win32' ? {} : { BROWSER: '/usr/bin/true' })
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: shouldCreateProcessGroup()
    });
    this.child = child;
    try {
      const pprofUrl = await waitForPprofUrl(child, this.output, () => this.stopCurrent());
      if (this.child !== child) return;
      child.once('exit', () => {
        if (this.child === child) {
          this.child = undefined;
          void this.stopCurrent();
        }
      });
      this.proxyUrl = await this.startProxy(pprofUrl);
      this.graphvizAvailable = await hasGraphviz(options.environment);
      this.activeSessionId = options.session.id;
    } catch (error) {
      await this.stopCurrent();
      throw error;
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const value = message as Record<string, unknown>;
    if (value.command === 'open-function' && typeof value.functionName === 'string') {
      this.options?.onOpenFunction(value.functionName);
    } else if (
      value.command === 'open-source'
      && typeof value.file === 'string'
      && Number.isInteger(value.line)
    ) {
      this.options?.onOpenSource(value.file, Number(value.line));
    } else if (value.command === 'selected-function' && typeof value.functionName === 'string') {
      this.selectedFunction = value.functionName;
      await this.view?.webview.postMessage({
        command: 'selection',
        functionName: this.selectedFunction
      });
    } else if (value.command === 'locate-current-function') {
      const functionName = await this.options?.onLocateCurrentFunction();
      if (functionName) {
        this.selectedFunction = functionName;
        await this.view?.webview.postMessage({ command: 'focus-function', functionName });
      }
    } else if (value.command === 'change-view' && isProfileView(value.view)) {
      this.activeView = value.view;
    } else if (
      value.command === 'change-graph-node-count'
      && typeof value.nodeCount === 'number'
      && [0, 80, 120, 300, 500].includes(value.nodeCount)
    ) {
      this.graphNodeCount = value.nodeCount;
    } else if (
      value.command === 'change-graph-config'
      && typeof value.nodeCount === 'number'
      && typeof value.nodeFraction === 'number'
      && typeof value.edgeFraction === 'number'
      && typeof value.callTree === 'boolean'
    ) {
      this.graphNodeCount = Math.max(0, Math.min(5000, Math.round(value.nodeCount)));
      this.graphNodeFraction = Math.max(0, Math.min(1, value.nodeFraction));
      this.graphEdgeFraction = Math.max(0, Math.min(1, value.edgeFraction));
      this.graphCallTree = value.callTree;
    } else if (value.command === 'change-sample' && typeof value.sampleType === 'string') {
      const options = this.options;
      if (!options || options.session.sampleType === value.sampleType) return;
      const artifact = this.artifacts.get(options.session.id);
      if (!artifact) return;
      const session = await options.onChangeSampleType(value.sampleType, artifact);
      if (!session) return;
      this.artifacts.set(session.id, artifact);
      this.activeSessionId = session.id;
      this.options = { ...options, session };
      this.render();
    }
  }

  private render(): void {
    if (!this.view) return;
    if (!this.options || !this.proxyUrl) {
      this.view.webview.html = emptyHtml();
      return;
    }
    const artifact = this.artifacts.get(this.options.session.id);
    const sampleTypes = artifact ? listProfileSampleTypes(artifact) : [];
    this.view.webview.html = viewerHtml(
      this.view.webview,
      this.proxyUrl,
      this.options.session,
      sampleTypes,
      this.activeView,
      this.selectedFunction,
      this.graphvizAvailable,
      this.graphNodeCount,
      this.graphNodeFraction,
      this.graphEdgeFraction,
      this.graphCallTree
    );
  }

  private async startProxy(pprofUrl: string): Promise<string> {
    const upstream = new URL(pprofUrl);
    const proxy = http.createServer((request, response) => {
      const target = new URL(request.url ?? '/', upstream);
      const headers = {
        ...request.headers,
        host: upstream.host,
        'accept-encoding': 'identity'
      };
      const upstreamRequest = http.request(target, {
        method: request.method,
        headers
      }, (upstreamResponse) => {
        const contentType = String(upstreamResponse.headers['content-type'] ?? '');
        if (!contentType.includes('text/html')) {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
          return;
        }
        const chunks: Buffer[] = [];
        upstreamResponse.on('data', (chunk: Buffer) => chunks.push(chunk));
        upstreamResponse.on('end', () => {
          const html = injectPprofBridge(Buffer.concat(chunks).toString('utf8'));
          const responseHeaders = { ...upstreamResponse.headers };
          delete responseHeaders['content-length'];
          delete responseHeaders['content-encoding'];
          responseHeaders['content-length'] = String(Buffer.byteLength(html));
          response.writeHead(upstreamResponse.statusCode ?? 200, responseHeaders);
          response.end(html);
        });
      });
      upstreamRequest.on('error', (error) => {
        if (!response.headersSent) {
          response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        }
        response.end(`GoTune pprof proxy error: ${error.message}`);
      });
      request.pipe(upstreamRequest);
    });
    this.proxy = proxy;
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', () => {
        proxy.off('error', reject);
        resolve();
      });
    });
    const address = proxy.address();
    if (!address || typeof address === 'string') {
      throw new Error('Could not start the local pprof bridge');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  private async stopCurrent(): Promise<void> {
    this.activeSessionId = undefined;
    this.proxyUrl = undefined;
    const child = this.child;
    this.child = undefined;
    if (child) signalProcessTree(child, 'SIGTERM');
    const proxy = this.proxy;
    this.proxy = undefined;
    if (proxy) {
      await new Promise<void>((resolve) => {
        proxy.close(() => resolve());
        proxy.closeAllConnections();
      });
    }
    const temporaryDirectory = this.temporaryDirectory;
    this.temporaryDirectory = undefined;
    if (temporaryDirectory) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

function waitForPprofUrl(
  child: ChildProcessWithoutNullStreams,
  outputChannel: Output,
  stop: () => Promise<void>
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = '';
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      void stop();
      reject(new Error('等待 go tool pprof 启动超时'));
    }, 30_000);
    const consume = (chunk: Buffer) => {
      const text = chunk.toString();
      outputChannel.append(text);
      output = `${output}${text}`.slice(-8000);
      const url = pprofViewerUrl(output);
      if (url && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(url);
      }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void stop();
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const detail = output.trim().split(/\r?\n/).at(-1);
      void stop();
      reject(new Error(
        detail || `go tool pprof exited before opening the viewer (code=${code}, signal=${signal})`
      ));
    });
  });
}

async function hasGraphviz(environment: Record<string, string>): Promise<boolean> {
  try {
    await execFileAsync('dot', ['-V'], {
      env: { ...process.env, ...environment },
      timeout: 5000
    });
    return true;
  } catch {
    return false;
  }
}

function viewerHtml(
  webview: vscode.Webview,
  proxyUrl: string,
  session: ProfileSession,
  sampleTypes: Array<{ name: string; unit: string }>,
  activeView: ProfileView,
  selectedFunction: string,
  graphvizAvailable: boolean,
  graphNodeCount: number,
  graphNodeFraction: number,
  graphEdgeFraction: number,
  graphCallTree: boolean
): string {
  const nonce = Math.random().toString(36).slice(2);
  const model = JSON.stringify({
    proxyUrl,
    profileKey: session.source,
    activeView,
    graphNodeCount,
    graphNodeFraction,
    graphEdgeFraction,
    graphCallTree,
    selectedFunction,
    sampleType: session.sampleType,
    sampleTypes: sampleTypes.map((sample) => ({
      name: sample.name,
      label: sampleTypeLabel(sample.name)
    })),
    tree: profileTreeRows(session),
    unit: session.sampleUnit,
    total: session.total
  }).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:*; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${nonce}">
    *{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:var(--vscode-scrollbarSlider-background) transparent}html,body{height:100%;margin:0;background:var(--vscode-panel-background,var(--vscode-editor-background));color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}::-webkit-scrollbar{width:7px;height:7px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:7px}::-webkit-scrollbar-corner{background:transparent}
    body{display:flex;flex-direction:column;overflow:hidden}.toolbar{height:40px;display:flex;align-items:center;gap:6px;padding:4px 10px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground)}
    .tabs{display:flex;gap:2px}.tab,.tool{border:0;border-radius:4px;padding:5px 9px;color:var(--vscode-foreground);background:transparent;cursor:pointer}.tab:hover,.tool:hover{background:var(--vscode-toolbar-hoverBackground)}.tab.active{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.tool.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
    .spacer{flex:1}.metric{display:flex;align-items:center;gap:6px;color:var(--vscode-descriptionForeground)}select{color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border);padding:4px 7px}
    .search-wrap{position:relative;display:flex;align-items:center;gap:3px}.search{width:180px;min-width:90px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:4px 7px}.search-nav{display:flex;align-items:center;gap:2px}.search-nav[hidden]{display:none}.search-nav button{border:0;border-radius:3px;padding:4px 6px;color:var(--vscode-foreground);background:transparent;cursor:pointer}.search-nav button:hover{background:var(--vscode-toolbar-hoverBackground)}.search-count{min-width:42px;text-align:center;color:var(--vscode-descriptionForeground);font-variant-numeric:tabular-nums}.search-results{position:absolute;z-index:30;top:31px;left:0;width:min(440px,70vw);max-height:280px;overflow:auto;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:5px;background:var(--vscode-editorWidget-background);box-shadow:0 8px 24px rgba(0,0,0,.35)}.search-results[hidden]{display:none}.search-result{display:block;width:100%;padding:6px 9px;overflow:hidden;text-align:left;text-overflow:ellipsis;white-space:nowrap;border:0;color:var(--vscode-foreground);background:transparent;cursor:pointer}.search-result:hover,.search-result.active{color:var(--vscode-list-activeSelectionForeground);background:var(--vscode-list-activeSelectionBackground)}
    .selection{max-width:30%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-descriptionForeground)}
    .tree-tools{display:flex;align-items:center;gap:8px;color:var(--vscode-descriptionForeground)}.tree-tools[hidden]{display:none}.tree-tools label{display:flex;align-items:center;gap:5px;white-space:nowrap}
    .warning{padding:5px 10px;background:var(--vscode-inputValidation-warningBackground);color:var(--vscode-inputValidation-warningForeground)}
    main{position:relative;flex:1;min-height:0}.view{position:absolute;inset:0}iframe{width:100%;height:100%;border:0;background:var(--vscode-editor-background)}
    .graph-tools{position:absolute;z-index:3;left:10px;top:10px;display:flex;flex-direction:column;gap:4px}.graph-tools[hidden]{display:none!important}.graph-tools button{width:30px;height:30px;border:1px solid var(--vscode-button-border,transparent);border-radius:4px;color:var(--vscode-foreground);background:var(--vscode-editorWidget-background);box-shadow:0 2px 7px rgba(0,0,0,.25);cursor:pointer}.graph-tools button:hover{background:var(--vscode-toolbar-hoverBackground)}
    .config-wrap{position:relative}.config-panel{position:absolute;z-index:20;top:35px;right:0;width:280px;padding:14px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:8px;background:var(--vscode-editorWidget-background);box-shadow:0 8px 24px rgba(0,0,0,.35)}.config-panel[hidden]{display:none}.config-title{font-weight:600;font-size:14px;margin-bottom:12px}.config-row{display:grid;grid-template-columns:1fr 110px;align-items:center;gap:10px;margin:9px 0}.config-row input{width:100%;padding:5px 7px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}.config-check{display:flex;align-items:center;gap:8px;margin:12px 0}.config-actions{display:flex;justify-content:flex-end;gap:7px;padding-top:11px;border-top:1px solid var(--vscode-panel-border)}
    #tree{overflow:auto}.tree-header,.tree-row{display:grid;grid-template-columns:minmax(360px,1fr) 110px 90px 120px 110px;min-width:820px;align-items:stretch;border-bottom:1px solid var(--vscode-panel-border)}
    .tree-header{position:sticky;top:0;z-index:2;background:var(--vscode-editorGroupHeader-tabsBackground);font-weight:600}.tree-header>span,.tree-row>span{padding:5px 8px;text-align:right;display:flex;align-items:center;justify-content:flex-end}.tree-header>span:first-child,.tree-row>span:first-child{text-align:left;justify-content:flex-start}
    .tree-row{cursor:default;min-height:29px}.tree-row:hover{background:var(--vscode-list-hoverBackground)}.tree-row.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.tree-row.match .tree-name{color:var(--vscode-editor-findMatchForeground);background:var(--vscode-editor-findMatchHighlightBackground);border-radius:2px}
    .function{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tree-guide{align-self:stretch;flex:0 0 16px;border-left:1px solid var(--vscode-tree-indentGuidesStroke,var(--vscode-panel-border));opacity:.8}.tree-branch{flex:0 0 14px;color:var(--vscode-tree-indentGuidesStroke,var(--vscode-descriptionForeground))}.twisty{flex:0 0 18px;width:18px;height:18px;margin-right:3px;padding:0;border:0;border-radius:3px;color:inherit;background:transparent;line-height:16px;cursor:pointer}.twisty:hover{background:var(--vscode-toolbar-hoverBackground)}.tree-name{overflow:hidden;text-overflow:ellipsis}.empty{padding:24px;color:var(--vscode-descriptionForeground)}
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="tabs">
      <button class="tab" data-view="top">Top</button>
      <button class="tab" data-view="graph">Graph</button>
      <button class="tab" data-view="flame">Flame Graph</button>
      <button class="tab" data-view="tree">Tree</button>
    </div>
    <select id="more" title="更多官方 pprof 视图">
      <option value="">更多视图…</option>
      <option value="peek">Peek</option>
      <option value="source">Source</option>
    </select>
    <button class="tool" id="locate" title="在 Profile 中定位编辑器当前函数">⌖ 定位当前函数</button>
    <button class="tool" id="open" title="打开所选函数源码" disabled>↗ 打开源码</button>
    <span class="selection" id="selection"></span>
    <span class="spacer"></span>
    <div class="search-wrap">
      <input class="search" id="search" placeholder="搜索函数（正则）">
      <div class="search-nav" id="searchNav" hidden>
        <button id="searchPrevious" title="上一个匹配">↑</button>
        <span class="search-count" id="searchCount">0 / 0</span>
        <button id="searchNext" title="下一个匹配">↓</button>
      </div>
      <div class="search-results" id="searchResults" hidden></div>
    </div>
    <div class="tree-tools" id="treeTools" hidden>
      <label>占比：<select id="treePercentMode"><option value="total">总量</option><option value="parent">父节点</option></select></label>
      <label><input id="treeSingleClick" type="checkbox">单击打开源码</label>
    </div>
    <div class="config-wrap">
      <button class="tool" id="configure" title="配置调用图">⚙ Graph 配置</button>
      <div class="config-panel" id="configPanel" hidden>
        <div class="config-title">调用图显示</div>
        <label class="config-row"><span>节点数</span><input id="configNodeCount" type="number" min="0" max="5000"></label>
        <label class="config-row"><span>节点阈值</span><input id="configNodeFraction" type="number" min="0" max="1" step="0.001"></label>
        <label class="config-row"><span>边阈值</span><input id="configEdgeFraction" type="number" min="0" max="1" step="0.001"></label>
        <label class="config-check"><input id="configCallTree" type="checkbox"><span>按调用路径拆分同名函数</span></label>
        <div class="config-actions"><button class="tool" id="configReset">恢复默认</button><button class="tool primary" id="configApply">应用</button></div>
      </div>
    </div>
    <label class="metric">显示：<select id="sample"></select></label>
  </div>
  ${graphvizAvailable ? '' : '<div class="warning">未找到 Graphviz dot。安装 Graphviz 后才能查看 Graph；Top、火焰图和 Tree 不受影响。</div>'}
  <main>
    <div class="graph-tools" id="graphTools">
      <button data-action="zoom-in" title="放大">＋</button>
      <button data-action="zoom-out" title="缩小">−</button>
      <button data-action="fit" title="适配整个调用图">↔</button>
    </div>
    <div class="graph-tools" id="flameTools" hidden>
      <button id="flameReset" title="重置火焰图聚焦">↺</button>
    </div>
    <iframe id="official" class="view"></iframe>
    <div id="tree" class="view" hidden>
      <div class="tree-header"><span>函数</span><span>自身</span><span id="treeFlatPercent">自身占比</span><span>累计</span><span id="treeCumPercent">累计占比</span></div>
      <div id="treeRows"></div>
    </div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const model = ${model};
    const savedState = vscode.getState();
    const restoredState = savedState?.profileKey===model.profileKey?savedState:{};
    const frame = document.getElementById('official');
    const tree = document.getElementById('tree');
    const sample = document.getElementById('sample');
    const more = document.getElementById('more');
    const selection = document.getElementById('selection');
    const open = document.getElementById('open');
    const search = document.getElementById('search');
    const searchNav = document.getElementById('searchNav');
    const searchCount = document.getElementById('searchCount');
    const searchResults = document.getElementById('searchResults');
    const configure = document.getElementById('configure');
    const configPanel = document.getElementById('configPanel');
    const configNodeCount = document.getElementById('configNodeCount');
    const configNodeFraction = document.getElementById('configNodeFraction');
    const configEdgeFraction = document.getElementById('configEdgeFraction');
    const configCallTree = document.getElementById('configCallTree');
    const treeTools = document.getElementById('treeTools');
    const treePercentMode = document.getElementById('treePercentMode');
    const treeSingleClick = document.getElementById('treeSingleClick');
    let currentView = model.activeView;
    let selectedFunction = model.selectedFunction;
    let pendingFocus = Boolean(model.selectedFunction);
    let graphNodeCount = model.graphNodeCount;
    let graphNodeFraction = model.graphNodeFraction;
    let graphEdgeFraction = model.graphEdgeFraction;
    let graphCallTree = model.graphCallTree;
    let graphLocateExpanded = false;
    let graphSearchResults = [];
    let graphSearchIndex = -1;
    let flameSearchIndex = -1;
    let flameSearchTotal = 0;
    let expanded = new Set(restoredState.expanded||[]);
    search.value=restoredState.search||'';
    treePercentMode.value=restoredState.treePercentMode||'total';
    treeSingleClick.checked=Boolean(restoredState.treeSingleClick);
    const saveState=()=>vscode.setState({
      profileKey:model.profileKey,
      search:search.value,
      expanded:[...expanded],
      treePercentMode:treePercentMode.value,
      treeSingleClick:treeSingleClick.checked
    });
    const colors = {
      bg:getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim(),
      fg:getComputedStyle(document.body).getPropertyValue('--vscode-foreground').trim(),
      header:getComputedStyle(document.body).getPropertyValue('--vscode-editorGroupHeader-tabsBackground').trim(),
      border:getComputedStyle(document.body).getPropertyValue('--vscode-panel-border').trim(),
      hover:getComputedStyle(document.body).getPropertyValue('--vscode-list-hoverBackground').trim(),
      muted:getComputedStyle(document.body).getPropertyValue('--vscode-descriptionForeground').trim(),
      selection:getComputedStyle(document.body).getPropertyValue('--vscode-focusBorder').trim()
    };
    const format = value => {
      if (model.unit === 'bytes') {
        const units=['B','KiB','MiB','GiB']; let index=0; let n=value;
        while(Math.abs(n)>=1024&&index<units.length-1){n/=1024;index++}
        return (index===0?Math.round(n):n.toFixed(n>=10?1:2))+' '+units[index];
      }
      if (model.unit === 'nanoseconds') {
        if(value>=1e9)return (value/1e9).toFixed(2)+' s';
        if(value>=1e6)return (value/1e6).toFixed(2)+' ms';
        if(value>=1e3)return (value/1e3).toFixed(2)+' μs';
        return value+' ns';
      }
      return new Intl.NumberFormat().format(value);
    };
    const viewPath = view => view==='top'?'/ui/top':view==='flame'?'/ui/flamegraph':view==='peek'?'/ui/peek':view==='source'?'/ui/source':'/ui/';
    const iframeUrl = () => {
      const params=new URLSearchParams({si:sample.value});
      if((currentView==='peek'||currentView==='source')&&selectedFunction)params.set('f',selectedFunction);
      if(currentView==='graph'){
        params.set('n',String(graphNodeCount));
        params.set('nf',String(graphNodeFraction));
        params.set('ef',String(graphEdgeFraction));
        if(graphCallTree)params.set('calltree','true');
      }
      return model.proxyUrl + viewPath(currentView) + '?' + params.toString();
    };
    const sendTheme = () => frame.contentWindow?.postMessage({source:'gotune-host',command:'theme',colors},'*');
    const focus = name => {
      if(!name)return;
      frame.contentWindow?.postMessage({source:'gotune-host',command:'focus-function',functionName:name},'*');
    };
    const searchProfile = query => {
      if(currentView==='tree'){renderTree();return}
      frame.contentWindow?.postMessage({source:'gotune-host',command:'search',query},'*');
    };
    const updateSearchControls = () => {
      const hasQuery=Boolean(search.value.trim());
      searchNav.hidden=currentView!=='flame'||!hasQuery;
      searchCount.textContent=flameSearchTotal>0?(flameSearchIndex+1)+' / '+flameSearchTotal:'0 / 0';
      searchResults.hidden=currentView!=='graph'||!hasQuery||graphSearchResults.length===0;
    };
    const selectGraphSearchResult = index => {
      if(graphSearchResults.length===0)return;
      graphSearchIndex=(index+graphSearchResults.length)%graphSearchResults.length;
      const name=graphSearchResults[graphSearchIndex];
      choose(name);
      vscode.postMessage({command:'selected-function',functionName:name});
      focus(name);
      searchResults.querySelectorAll('.search-result').forEach((item,rowIndex)=>item.classList.toggle('active',rowIndex===graphSearchIndex));
    };
    const renderGraphSearchResults = () => {
      searchResults.textContent='';
      graphSearchResults.forEach((name,index)=>{
        const button=document.createElement('button');
        button.className='search-result';
        button.textContent=name;
        button.title=name;
        button.addEventListener('click',()=>selectGraphSearchResult(index));
        searchResults.appendChild(button);
      });
      updateSearchControls();
    };
    const choose = name => {
      if(selectedFunction!==(name||''))graphLocateExpanded=false;
      selectedFunction=name||'';selection.textContent=selectedFunction;open.disabled=!selectedFunction;
      document.querySelectorAll('.tree-row').forEach(row=>row.classList.toggle('selected',row.dataset.name===selectedFunction));
    };
    const setView = view => {
      currentView=view;
      document.querySelectorAll('.tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.view===view));
      more.value=view==='peek'||view==='source'?view:'';
      tree.hidden=view!=='tree';frame.hidden=view==='tree';
      document.getElementById('graphTools').hidden=view!=='graph';
      document.getElementById('flameTools').hidden=view!=='flame';
      configure.hidden=view!=='graph';
      treeTools.hidden=view!=='tree';
      graphSearchResults=[];graphSearchIndex=-1;flameSearchIndex=-1;flameSearchTotal=0;
      renderGraphSearchResults();
      if(view==='tree'){revealTreeSelection();renderTree()}else{pendingFocus=Boolean(selectedFunction);frame.src=iframeUrl()}
      vscode.postMessage({command:'change-view',view});
    };
    const revealTreeSelection = () => {
      if(!selectedFunction)return;
      const row=model.tree.find(item=>item.name===selectedFunction);
      if(!row)return;
      const byId=new Map(model.tree.map(item=>[item.id,item]));
      let current=row;
      while(current?.parentId){expanded.add(current.parentId);current=byId.get(current.parentId)}
    };
    const matchesTree = (name,query) => {
      if(!query)return false;
      try{return new RegExp(query,'i').test(name)}catch{return name.toLowerCase().includes(query.toLowerCase())}
    };
    const visibleRows = query => {
      if(query){
        const matches=model.tree.filter(row=>matchesTree(row.name,query));
        const byId=new Map(model.tree.map(row=>[row.id,row]));
        const needed=new Set();
        for(const match of matches){
          let current=match;
          while(current){needed.add(current.id);current=current.parentId?byId.get(current.parentId):undefined}
        }
        return model.tree.filter(row=>needed.has(row.id));
      }
      const visible=[];const visibleDepth=new Map();
      for(const row of model.tree){
        const parentVisible=row.parentId===undefined||visibleDepth.get(row.parentId)===true;
        const shown=parentVisible&&(row.parentId===undefined||expanded.has(row.parentId));
        visibleDepth.set(row.id,shown);if(shown)visible.push(row);
      }
      return visible;
    };
    const renderTree = () => {
      const container=document.getElementById('treeRows');container.textContent='';
      const query=search.value.trim();
      const parentTotal=row=>treePercentMode.value==='parent'?(row.parentValue??model.total):model.total;
      const rowPercent=(value,row)=>parentTotal(row)?(value/parentTotal(row)*100).toFixed(2)+'%':'0.00%';
      document.getElementById('treeFlatPercent').textContent=treePercentMode.value==='parent'?'自身/父级':'自身占比';
      document.getElementById('treeCumPercent').textContent=treePercentMode.value==='parent'?'累计/父级':'累计占比';
      for(const row of visibleRows(query)){
        const element=document.createElement('div');element.className='tree-row';element.dataset.name=row.name;
        if(matchesTree(row.name,query))element.classList.add('match');
        const guides='<span class="tree-guide"></span>'.repeat(Math.max(0,row.depth-1));
        const branch=row.depth?'<span class="tree-branch">└</span>':'';
        element.innerHTML='<span class="function">'+guides+branch+'<button class="twisty" title="'+(row.hasChildren?'展开或折叠调用层级':'')+'">'+(row.hasChildren?(expanded.has(row.id)?'⌄':'›'):'')+'</button><span class="tree-name">'+escapeText(row.name)+'</span></span><span>'+format(row.flat)+'</span><span>'+rowPercent(row.flat,row)+'</span><span>'+format(row.value)+'</span><span>'+rowPercent(row.value,row)+'</span>';
        element.querySelector('.twisty').addEventListener('click',event=>{event.stopPropagation();if(row.hasChildren){expanded.has(row.id)?expanded.delete(row.id):expanded.add(row.id);saveState();renderTree()}});
        element.addEventListener('click',()=>{choose(row.name);vscode.postMessage({command:'selected-function',functionName:row.name});if(treeSingleClick.checked)vscode.postMessage({command:'open-function',functionName:row.name})});
        element.addEventListener('dblclick',()=>{if(!treeSingleClick.checked)vscode.postMessage({command:'open-function',functionName:row.name})});
        container.appendChild(element);
      }
      choose(selectedFunction);
    };
    const escapeText = value => value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    for(const item of model.sampleTypes){const option=document.createElement('option');option.value=item.name;option.textContent=item.label;option.selected=item.name===model.sampleType;sample.appendChild(option)}
    sample.addEventListener('change',()=>vscode.postMessage({command:'change-sample',sampleType:sample.value}));
    more.addEventListener('change',()=>{if(more.value)setView(more.value)});
    search.addEventListener('input',()=>{
      graphSearchResults=[];graphSearchIndex=-1;flameSearchIndex=-1;flameSearchTotal=0;
      saveState();updateSearchControls();searchProfile(search.value)
    });
    search.addEventListener('keydown',event=>{
      if(event.key==='Escape'){
        search.value='';search.dispatchEvent(new Event('input'));searchResults.hidden=true;return;
      }
      if(event.key!=='Enter')return;
      event.preventDefault();
      if(currentView==='graph'){
        selectGraphSearchResult(graphSearchIndex<0?0:graphSearchIndex+(event.shiftKey?-1:1));
      }else if(currentView==='flame'){
        frame.contentWindow?.postMessage({source:'gotune-host',command:'search-step',delta:event.shiftKey?-1:1},'*');
      }
    });
    document.getElementById('searchPrevious').addEventListener('click',()=>frame.contentWindow?.postMessage({source:'gotune-host',command:'search-step',delta:-1},'*'));
    document.getElementById('searchNext').addEventListener('click',()=>frame.contentWindow?.postMessage({source:'gotune-host',command:'search-step',delta:1},'*'));
    treePercentMode.addEventListener('change',()=>{saveState();renderTree()});
    treeSingleClick.addEventListener('change',saveState);
    frame.addEventListener('load',sendTheme);
    window.addEventListener('message',event=>{
      const message=event.data;
      if(message?.source==='gotune-pprof'){
        if(message.command==='selected-function')choose(message.functionName);
        else if(message.command==='open-function'||message.command==='open-source')vscode.postMessage(message);
        else if(message.command==='search-results'&&message.view===currentView){
          if(currentView==='graph'){
            graphSearchResults=[...new Set(message.results||[])];
            graphSearchIndex=-1;
            renderGraphSearchResults();
          }else if(currentView==='flame'){
            flameSearchTotal=(message.results||[]).length;
            updateSearchControls();
          }
        }
        else if(message.command==='search-position'&&message.view==='flame'){
          flameSearchIndex=Number(message.index);
          flameSearchTotal=Number(message.total);
          updateSearchControls();
        }
        else if(message.command==='ready'){sendTheme();if(pendingFocus&&selectedFunction){pendingFocus=false;focus(selectedFunction)}else searchProfile(search.value)}
        else if(message.command==='focus-missed'&&currentView==='graph'){
          if(!graphLocateExpanded){
            graphLocateExpanded=true;
            graphNodeCount=Math.max(graphNodeCount,500);
            graphNodeFraction=0;
            graphEdgeFraction=0;
            pendingFocus=true;
            selection.textContent=message.functionName+' · 正在展开调用图定位';
            frame.src=iframeUrl();
          }else selection.textContent=message.functionName+' · 本次 Profile 没有可定位的图节点';
        }
      }else if(message?.command==='focus-function'){choose(message.functionName);pendingFocus=false;if(currentView==='tree'){revealTreeSelection();renderTree()}else if(currentView==='peek'||currentView==='source')frame.src=iframeUrl();else focus(message.functionName)}
      else if(message?.command==='selection')choose(message.functionName);
    });
    document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>setView(tab.dataset.view)));
    document.querySelectorAll('#graphTools button').forEach(button=>button.addEventListener('click',()=>frame.contentWindow?.postMessage({source:'gotune-host',command:'graph-control',action:button.dataset.action},'*')));
    document.getElementById('flameReset').addEventListener('click',()=>{
      pendingFocus=false;
      frame.contentWindow?.postMessage({source:'gotune-host',command:'flame-reset'},'*');
    });
    const syncGraphConfig=()=>{
      configNodeCount.value=String(graphNodeCount);
      configNodeFraction.value=String(graphNodeFraction);
      configEdgeFraction.value=String(graphEdgeFraction);
      configCallTree.checked=graphCallTree;
    };
    configure.addEventListener('click',event=>{event.stopPropagation();configPanel.hidden=!configPanel.hidden;syncGraphConfig()});
    configPanel.addEventListener('click',event=>event.stopPropagation());
    document.addEventListener('click',()=>configPanel.hidden=true);
    document.getElementById('configReset').addEventListener('click',()=>{graphNodeCount=80;graphNodeFraction=.005;graphEdgeFraction=.001;graphCallTree=false;syncGraphConfig()});
    document.getElementById('configApply').addEventListener('click',()=>{
      graphNodeCount=Math.max(0,Math.min(5000,Number(configNodeCount.value)||0));
      graphNodeFraction=Math.max(0,Math.min(1,Number(configNodeFraction.value)||0));
      graphEdgeFraction=Math.max(0,Math.min(1,Number(configEdgeFraction.value)||0));
      graphCallTree=configCallTree.checked;
      graphLocateExpanded=false;configPanel.hidden=true;pendingFocus=false;
      vscode.postMessage({command:'change-graph-config',nodeCount:graphNodeCount,nodeFraction:graphNodeFraction,edgeFraction:graphEdgeFraction,callTree:graphCallTree});
      frame.src=iframeUrl();
    });
    document.getElementById('locate').addEventListener('click',()=>vscode.postMessage({command:'locate-current-function'}));
    open.addEventListener('click',()=>{if(selectedFunction)vscode.postMessage({command:'open-function',functionName:selectedFunction})});
    choose(selectedFunction);setView(currentView);
  </script>
</body>
</html>`;
}

function emptyHtml(): string {
  return `<!doctype html><html><body style="margin:0;padding:28px;color:var(--vscode-descriptionForeground);background:var(--vscode-panel-background,var(--vscode-editor-background));font-family:var(--vscode-font-family)">从左侧采集或选择一个 Profile 后，这里显示 Top、Graph、Flame Graph 和 Tree。</body></html>`;
}

function sampleTypeLabel(sampleType: string): string {
  if (sampleType === 'cpu') return 'CPU 时间';
  if (sampleType === 'alloc_objects') return '累计分配对象';
  if (sampleType === 'alloc_space') return '累计分配空间';
  if (sampleType === 'inuse_objects') return '存活对象';
  if (sampleType === 'inuse_space') return '存活内存';
  if (/mutex|contentions/i.test(sampleType)) return '锁竞争';
  if (/block|delay/i.test(sampleType)) return '阻塞等待';
  return sampleType;
}

function isProfileView(value: unknown): value is ProfileView {
  return value === 'top'
    || value === 'graph'
    || value === 'flame'
    || value === 'tree'
    || value === 'peek'
    || value === 'source';
}
