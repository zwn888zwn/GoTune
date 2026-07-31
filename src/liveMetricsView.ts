import * as vscode from 'vscode';
import { RuntimeMetrics } from './model';

export class LiveMetricsView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly samples: RuntimeMetrics[] = [];
  private targetActive = false;
  private cpuRecordingStartedAt: number | undefined;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    view.webview.html = liveMetricsHtml(
      this.targetActive,
      this.samples,
      this.cpuRecordingStartedAt
    );
  }

  setTargetActive(active: boolean): void {
    this.targetActive = active;
    if (!active) {
      this.samples.splice(0);
      this.cpuRecordingStartedAt = undefined;
    }
    void this.view?.webview.postMessage({ command: 'target-state', active });
  }

  update(metrics: RuntimeMetrics): void {
    this.samples.push(metrics);
    if (this.samples.length > 300) this.samples.shift();
    void this.view?.webview.postMessage({ command: 'runtime-metrics', metrics });
  }

  setCpuRecording(startedAt: number | undefined): void {
    this.cpuRecordingStartedAt = startedAt;
    void this.view?.webview.postMessage({ command: 'cpu-recording', startedAt });
  }
}

function liveMetricsHtml(
  targetActive: boolean,
  samples: RuntimeMetrics[],
  cpuRecordingStartedAt: number | undefined
): string {
  const nonce = Math.random().toString(36).slice(2);
  const model = JSON.stringify({
    targetActive,
    samples,
    cpuRecordingStartedAt
  }).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${nonce}">
    *{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:var(--vscode-scrollbarSlider-background) transparent}
    html,body{margin:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font-family:var(--vscode-font-family);font-size:12px}
    body{padding:8px 10px 12px}::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:6px}
    .empty{padding:10px 3px;color:var(--vscode-descriptionForeground);line-height:1.5}.charts[hidden],.empty[hidden]{display:none}
    .chart{margin-bottom:12px}.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;padding-left:42px}.name{font-weight:600}.value{color:var(--vscode-descriptionForeground);font-variant-numeric:tabular-nums}
    .plot-row{display:grid;grid-template-columns:38px minmax(0,1fr);gap:4px}.y-axis{height:92px;display:flex;flex-direction:column;justify-content:space-between;padding:2px 0;color:var(--vscode-descriptionForeground);font-size:9px;text-align:right;font-variant-numeric:tabular-nums}
    svg{display:block;width:100%;height:92px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-editor-background)}
    .grid{stroke:var(--vscode-panel-border);stroke-width:1}.cpu-area{fill:color-mix(in srgb,var(--vscode-charts-green) 24%,transparent)}.cpu-line{fill:none;stroke:var(--vscode-charts-green);stroke-width:2}.heap-area{fill:color-mix(in srgb,var(--vscode-charts-blue) 30%,transparent)}.heap-line{fill:none;stroke:var(--vscode-charts-blue);stroke-width:2}
    .axis{display:flex;justify-content:space-between;min-height:16px;padding:3px 0 0 42px;color:var(--vscode-descriptionForeground);font-size:10px;font-variant-numeric:tabular-nums}.recording{margin:-4px 0 0 42px;color:var(--vscode-errorForeground);font-variant-numeric:tabular-nums}
  </style>
</head>
<body>
  <div class="empty" id="empty">使用 GoTune 启动目标后，这里显示最近 5 分钟的 CPU 与 Heap 趋势。</div>
  <div class="charts" id="charts" hidden>
    <section class="chart">
      <div class="head"><span class="name">CPU</span><span class="value" id="cpuValue">—</span></div>
      <div class="plot-row"><div class="y-axis" id="cpuYAxis"></div><svg viewBox="0 0 300 90" preserveAspectRatio="none"><path class="grid" d="M0 30H300M0 60H300M75 0V90M150 0V90M225 0V90"></path><polygon id="cpuArea" class="cpu-area"></polygon><polyline id="cpuLine" class="cpu-line"></polyline></svg></div>
      <div class="axis" id="cpuAxis"></div><div class="recording" id="recording"></div>
    </section>
    <section class="chart">
      <div class="head"><span class="name">Heap</span><span class="value" id="heapValue">—</span></div>
      <div class="plot-row"><div class="y-axis" id="heapYAxis"></div><svg viewBox="0 0 300 90" preserveAspectRatio="none"><path class="grid" d="M0 30H300M0 60H300M75 0V90M150 0V90M225 0V90"></path><polygon id="heapArea" class="heap-area"></polygon><polyline id="heapLine" class="heap-line"></polyline></svg></div>
      <div class="axis" id="heapAxis"></div>
    </section>
  </div>
  <script nonce="${nonce}">
    const model=${model};
    let samples=[...model.samples],recordingStartedAt=model.cpuRecordingStartedAt;
    const byId=id=>document.getElementById(id);
    const points=(values,max)=>{if(!values.length)return '';return values.map((value,index)=>{const x=values.length===1?0:index/(values.length-1)*300;const y=86-Math.max(0,value)/Math.max(1,max)*80;return x.toFixed(1)+','+y.toFixed(1)}).join(' ')};
    const bytes=value=>value>=1073741824?(value/1073741824).toFixed(1)+' GiB':value>=1048576?(value/1048576).toFixed(1)+' MiB':value>=1024?(value/1024).toFixed(1)+' KiB':Math.round(value)+' B';
    const niceMax=value=>{if(value<=0)return 1;const power=Math.pow(10,Math.floor(Math.log10(value))),scaled=value/power,step=scaled<=1?1:scaled<=2?2:scaled<=5?5:10;return step*power};
    const elapsed=value=>{const seconds=Math.max(0,Math.floor(value/1000));return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(item=>String(item).padStart(2,'0')).join(':')};
    const renderAxis=id=>{const axis=byId(id);axis.textContent='';if(!samples.length)return;const count=Math.min(3,samples.length);for(let index=0;index<count;index++){const sampleIndex=count===1?0:Math.round(index*(samples.length-1)/(count-1));const label=document.createElement('span');label.textContent=new Date(samples[sampleIndex].timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});axis.appendChild(label)}};
    const renderY=(id,max,format)=>{const axis=byId(id);axis.textContent='';[max,max/2,0].forEach(value=>{const label=document.createElement('span');label.textContent=format(value);axis.appendChild(label)})};
    const render=()=>{const cpu=samples.map(item=>item.cpuPercent??0),heap=samples.map(item=>item.heapAlloc),cpuMax=Math.max(100,niceMax(Math.max(...cpu,0))),heapMax=niceMax(Math.max(...heap,0)),cpuPoints=points(cpu,cpuMax),heapPoints=points(heap,heapMax);byId('cpuLine').setAttribute('points',cpuPoints);byId('cpuArea').setAttribute('points',cpu.length?'0,90 '+cpuPoints+' 300,90':'');byId('heapLine').setAttribute('points',heapPoints);byId('heapArea').setAttribute('points',heap.length?'0,90 '+heapPoints+' 300,90':'');byId('cpuValue').textContent=cpu.length?cpu.at(-1).toFixed(1)+'%':'—';byId('heapValue').textContent=heap.length?bytes(heap.at(-1)):'—';byId('recording').textContent=recordingStartedAt?'● CPU 录制中 '+elapsed(Date.now()-recordingStartedAt):'';renderY('cpuYAxis',cpuMax,value=>Math.round(value)+'%');renderY('heapYAxis',heapMax,bytes);renderAxis('cpuAxis');renderAxis('heapAxis');byId('empty').hidden=model.targetActive;byId('charts').hidden=!model.targetActive};
    window.addEventListener('message',event=>{if(event.data?.command==='runtime-metrics'){samples.push(event.data.metrics);if(samples.length>300)samples.shift()}else if(event.data?.command==='cpu-recording'){recordingStartedAt=event.data.startedAt}else if(event.data?.command==='target-state'){model.targetActive=event.data.active;if(!model.targetActive)samples=[]}render()});
    setInterval(render,1000);render();
  </script>
</body>
</html>`;
}
