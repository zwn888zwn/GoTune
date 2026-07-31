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
    this.options = options;
    this.selectedFunction = options.focusedFunction ?? '';
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
      this.view.webview.html = emptyHtml(this.view.webview);
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
      this.graphvizAvailable
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
  graphvizAvailable: boolean
): string {
  const nonce = Math.random().toString(36).slice(2);
  const model = JSON.stringify({
    proxyUrl,
    activeView,
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
    *{box-sizing:border-box}html,body{height:100%;margin:0;background:var(--vscode-panel-background,var(--vscode-editor-background));color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
    body{display:flex;flex-direction:column;overflow:hidden}.toolbar{height:38px;display:flex;align-items:center;gap:6px;padding:4px 10px;border-bottom:1px solid var(--vscode-panel-border)}
    .tabs{display:flex;gap:2px}.tab,.tool{border:0;border-radius:4px;padding:5px 9px;color:var(--vscode-foreground);background:transparent;cursor:pointer}.tab:hover,.tool:hover{background:var(--vscode-toolbar-hoverBackground)}.tab.active{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
    .spacer{flex:1}.metric{display:flex;align-items:center;gap:6px;color:var(--vscode-descriptionForeground)}select{color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border);padding:4px 7px}
    .search{width:180px;min-width:90px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:4px 7px}
    .selection{max-width:30%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-descriptionForeground)}
    .warning{padding:5px 10px;background:var(--vscode-inputValidation-warningBackground);color:var(--vscode-inputValidation-warningForeground)}
    main{position:relative;flex:1;min-height:0}.view{position:absolute;inset:0}iframe{width:100%;height:100%;border:0;background:var(--vscode-editor-background)}
    #tree{overflow:auto}.tree-header,.tree-row{display:grid;grid-template-columns:minmax(300px,1fr) 110px 90px 120px 110px;min-width:760px;align-items:center;border-bottom:1px solid var(--vscode-panel-border)}
    .tree-header{position:sticky;top:0;z-index:2;background:var(--vscode-editorGroupHeader-tabsBackground);font-weight:600}.tree-header span,.tree-row span{padding:5px 8px;text-align:right}.tree-header span:first-child,.tree-row span:first-child{text-align:left}
    .tree-row{cursor:default}.tree-row:hover{background:var(--vscode-list-hoverBackground)}.tree-row.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
    .function{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.twisty{display:inline-block;width:16px;text-align:center}.empty{padding:24px;color:var(--vscode-descriptionForeground)}
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
    <input class="search" id="search" placeholder="搜索函数（正则）">
    <label class="metric">显示：<select id="sample"></select></label>
  </div>
  ${graphvizAvailable ? '' : '<div class="warning">未找到 Graphviz dot。安装 Graphviz 后才能查看 Graph；Top、火焰图和 Tree 不受影响。</div>'}
  <main>
    <iframe id="official" class="view"></iframe>
    <div id="tree" class="view" hidden>
      <div class="tree-header"><span>函数</span><span>自身</span><span>自身占比</span><span>累计</span><span>累计占比</span></div>
      <div id="treeRows"></div>
    </div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const model = ${model};
    const frame = document.getElementById('official');
    const tree = document.getElementById('tree');
    const sample = document.getElementById('sample');
    const more = document.getElementById('more');
    const selection = document.getElementById('selection');
    const open = document.getElementById('open');
    const search = document.getElementById('search');
    let currentView = model.activeView;
    let selectedFunction = model.selectedFunction;
    let expanded = new Set(model.tree.filter(row => row.depth < 2).map(row => row.id));
    const colors = {
      bg:getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim(),
      fg:getComputedStyle(document.body).getPropertyValue('--vscode-foreground').trim(),
      header:getComputedStyle(document.body).getPropertyValue('--vscode-editorGroupHeader-tabsBackground').trim(),
      border:getComputedStyle(document.body).getPropertyValue('--vscode-panel-border').trim(),
      hover:getComputedStyle(document.body).getPropertyValue('--vscode-list-hoverBackground').trim()
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
    const percent = value => model.total ? (value/model.total*100).toFixed(2)+'%' : '0.00%';
    const viewPath = view => view==='top'?'/ui/top':view==='flame'?'/ui/flamegraph':view==='peek'?'/ui/peek':view==='source'?'/ui/source':'/ui/';
    const iframeUrl = () => {
      const params=new URLSearchParams({si:sample.value});
      if((currentView==='peek'||currentView==='source')&&selectedFunction)params.set('f',selectedFunction);
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
    const choose = name => {
      selectedFunction=name||'';selection.textContent=selectedFunction;open.disabled=!selectedFunction;
      document.querySelectorAll('.tree-row').forEach(row=>row.classList.toggle('selected',row.dataset.name===selectedFunction));
    };
    const setView = view => {
      currentView=view;
      document.querySelectorAll('.tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.view===view));
      more.value=view==='peek'||view==='source'?view:'';
      tree.hidden=view!=='tree';frame.hidden=view==='tree';
      if(view==='tree')renderTree();else frame.src=iframeUrl();
      vscode.postMessage({command:'change-view',view});
    };
    const visibleRows = () => {
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
      const query=search.value.trim().toLowerCase();
      for(const row of visibleRows().filter(row=>!query||row.name.toLowerCase().includes(query))){
        const element=document.createElement('div');element.className='tree-row';element.dataset.name=row.name;
        element.innerHTML='<span class="function" style="padding-left:'+(8+row.depth*16)+'px"><span class="twisty">'+(row.hasChildren?(expanded.has(row.id)?'⌄':'›'):'')+'</span>'+escapeText(row.name)+'</span><span>'+format(row.flat)+'</span><span>'+percent(row.flat)+'</span><span>'+format(row.value)+'</span><span>'+percent(row.value)+'</span>';
        element.addEventListener('click',()=>{if(row.hasChildren){expanded.has(row.id)?expanded.delete(row.id):expanded.add(row.id);renderTree()}choose(row.name);vscode.postMessage({command:'selected-function',functionName:row.name})});
        element.addEventListener('dblclick',()=>vscode.postMessage({command:'open-function',functionName:row.name}));
        container.appendChild(element);
      }
      choose(selectedFunction);
    };
    const escapeText = value => value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    for(const item of model.sampleTypes){const option=document.createElement('option');option.value=item.name;option.textContent=item.label;option.selected=item.name===model.sampleType;sample.appendChild(option)}
    sample.addEventListener('change',()=>vscode.postMessage({command:'change-sample',sampleType:sample.value}));
    more.addEventListener('change',()=>{if(more.value)setView(more.value)});
    search.addEventListener('input',()=>searchProfile(search.value));
    frame.addEventListener('load',()=>{sendTheme();selectedFunction?focus(selectedFunction):searchProfile(search.value)});
    window.addEventListener('message',event=>{
      const message=event.data;
      if(message?.source==='gotune-pprof'){
        if(message.command==='selected-function')choose(message.functionName);
        else if(message.command==='open-function'||message.command==='open-source')vscode.postMessage(message);
        else if(message.command==='ready'){sendTheme();selectedFunction?focus(selectedFunction):searchProfile(search.value)}
      }else if(message?.command==='focus-function'){choose(message.functionName);if(currentView==='peek'||currentView==='source')frame.src=iframeUrl();else focus(message.functionName)}
      else if(message?.command==='selection')choose(message.functionName);
    });
    document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>setView(tab.dataset.view)));
    document.getElementById('locate').addEventListener('click',()=>vscode.postMessage({command:'locate-current-function'}));
    open.addEventListener('click',()=>{if(selectedFunction)vscode.postMessage({command:'open-function',functionName:selectedFunction})});
    choose(selectedFunction);setView(currentView);
  </script>
</body>
</html>`;
}

function emptyHtml(webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'"><style nonce="${nonce}">body{padding:20px;color:var(--vscode-descriptionForeground);background:var(--vscode-panel-background,var(--vscode-editor-background));font-family:var(--vscode-font-family)}h2{color:var(--vscode-foreground)}</style></head><body><h2>Profiling with pprof</h2><p>启动 Go 程序并采集 CPU 或内存 Profile，结果会显示在这里。</p><p>也可以从 GoTune 左侧面板导入已有的 pprof 文件。</p></body></html>`;
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
