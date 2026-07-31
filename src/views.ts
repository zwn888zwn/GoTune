import * as vscode from 'vscode';
import { isRuntimeHotspot } from './classify';
import {
  Hotspot,
  Investigation,
  PerformanceFinding,
  PerformanceScenario,
  ProfileSession
} from './model';
import { RunnerSnapshot } from './runner';
import { formatValue } from './webview';

export class RunningItem extends vscode.TreeItem {
  constructor(
    label: string,
    description: string | undefined,
    icon: string,
    command?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'gotuneRunningItem';
    if (command) {
      this.command = { command, title: label };
    }
  }
}

export function runningItems(
  snapshot: RunnerSnapshot,
  activeSession?: ProfileSession,
  baselineSessionId?: string,
  isApplicationSource: (filename: string) => boolean = () => true
): vscode.TreeItem[] {
  const evidence = activeSession
    ? [
      new SessionItem(
        activeSession,
        activeSession.id === baselineSessionId ? 'baseline' : 'current'
      ),
      ...activeSession.hotspots
        .filter((hotspot) =>
          hotspot.location
          && !isRuntimeHotspot(hotspot)
          && isApplicationSource(hotspot.location.file)
        )
        .slice(0, 12)
        .map((hotspot) => new HotspotItem(hotspot, activeSession))
    ]
    : [];
  if (snapshot.status === 'idle') {
    return [
      new RunningItem('分析当前函数', '在 pprof 中定位并查看调用关系', 'symbol-method', 'gotune.analyzeCurrentFunction'),
      new RunningItem('启动当前 Go main', '自动注入 pprof 并运行当前 main 包', 'run', 'gotune.runWithProfiler'),
      new RunningItem('连接 pprof 服务', '分析已经运行的 Go 进程', 'plug', 'gotune.fetchProfile'),
      new RunningItem('导入 pprof 文件', '打开已有 CPU 或 Heap Profile', 'folder-opened', 'gotune.importProfile'),
      ...evidence
    ];
  }
  if (snapshot.status === 'starting') {
    return [
      new RunningItem('正在启动分析目标…', snapshot.target?.importPath, 'loading~spin'),
      new RunningItem('查看目标输出', undefined, 'output', 'gotune.showTargetOutput')
    ];
  }
  if (snapshot.status === 'stopping') {
    return [new RunningItem('正在停止分析目标…', snapshot.target?.importPath, 'loading~spin')];
  }
  return [
    new RunningItem(snapshot.target?.importPath ?? 'Go 目标', `运行中 · PID ${snapshot.pid ?? '—'}`, 'vm-running'),
    new RunningItem('分析当前函数', '在 pprof 中定位并查看调用关系', 'symbol-method', 'gotune.analyzeCurrentFunction'),
    new RunningItem('采集 CPU', '采集期间请触发需要分析的业务操作', 'flame', 'gotune.captureCpu'),
    new RunningItem('采集当前存活内存', '强制 GC 后查看仍然存活的分配路径', 'database', 'gotune.captureHeap'),
    ...evidence,
    new RunningItem('查看目标输出', undefined, 'output', 'gotune.showTargetOutput'),
    new RunningItem('停止目标', undefined, 'debug-stop', 'gotune.stopProfilerTarget')
  ];
}

export class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly session: ProfileSession,
    state: 'baseline' | 'current' | 'normal' = 'normal'
  ) {
    super(session.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'gotuneSession';
    const stateLabel = state === 'baseline' ? '基线 · ' : state === 'current' ? '当前 · ' : '';
    this.description = `${stateLabel}${sampleTypeLabel(session.sampleType)} · ${formatValue(session.total, session.sampleUnit)}`;
    this.tooltip = [
      `${stateLabel || '性能证据 · '}${session.source}`,
      session.target ? `目标：${session.target}` : undefined,
      session.captureDurationMs ? `采集时长：${session.captureDurationMs / 1000}s` : undefined,
      `采集时间：${new Date(session.importedAt).toLocaleString()}`
    ].filter(Boolean).join('\n');
    this.iconPath = new vscode.ThemeIcon(
      state === 'baseline' ? 'target' : state === 'current' ? 'arrow-right' : 'pulse'
    );
    this.command = { command: 'gotune.showProfile', title: '查看性能证据', arguments: [this] };
  }
}

export class HotspotItem extends vscode.TreeItem {
  constructor(public readonly hotspot: Hotspot, session: ProfileSession) {
    super(hotspot.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'gotuneHotspot';
    const percent = session.total === 0 ? 0 : hotspot.cumulative / session.total * 100;
    this.description = `${percent.toFixed(1)}% 包含下游`;
    this.tooltip = [
      `自身：${formatValue(hotspot.flat, session.sampleUnit)}`,
      `包含下游：${formatValue(hotspot.cumulative, session.sampleUnit)}`,
      hotspot.location ? `${hotspot.location.file}:${hotspot.location.line}` : '没有源码位置'
    ].join('\n');
    this.iconPath = new vscode.ThemeIcon(hotspot.location ? 'flame' : 'symbol-method');
    if (hotspot.location) {
      this.command = { command: 'gotune.showSource', title: '打开源码', arguments: [this] };
    }
  }
}

function sampleTypeLabel(sampleType: string): string {
  if (sampleType === 'cpu') return 'CPU';
  if (sampleType === 'inuse_space') return '存活内存';
  if (sampleType === 'inuse_objects') return '存活对象';
  if (sampleType === 'alloc_space') return '累计分配';
  if (sampleType === 'alloc_objects') return '分配对象';
  return sampleType;
}

export class InvestigationFindingItem extends vscode.TreeItem {
  readonly hotspot: Hotspot | undefined;

  constructor(public readonly finding: PerformanceFinding, session?: ProfileSession) {
    super(finding.title, vscode.TreeItemCollapsibleState.None);
    this.hotspot = finding.location
      ? session?.hotspots.find((hotspot) =>
        hotspot.location?.file === finding.location?.file
        && hotspot.location?.line === finding.location?.line
      )
      : undefined;
    this.description = finding.detail;
    this.tooltip = `${finding.title}\n\n${finding.detail}`;
    this.iconPath = new vscode.ThemeIcon(
      finding.severity === 'suspicious' ? 'warning'
        : finding.severity === 'verified' ? 'verified'
          : finding.severity === 'watch' ? 'eye' : 'lightbulb'
    );
    this.contextValue = 'gotuneFinding';
    if (finding.location) {
      this.command = {
        command: 'gotune.showFindingSource',
        title: 'Open Finding Source',
        arguments: [finding]
      };
    }
  }
}

export class InvestigationSummaryItem extends vscode.TreeItem {
  constructor(investigation: Investigation, label: string, description?: string, icon = 'info') {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.tooltip = `${investigation.name}\n${investigation.target ?? 'No target'}\nUpdated ${new Date(investigation.updatedAt).toLocaleString()}`;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'gotuneInvestigationSummary';
  }
}

export function investigationItems(investigation: Investigation | undefined): InvestigationSummaryItem[] {
  if (!investigation) {
    return [new InvestigationSummaryItem(
      {
        id: '',
        name: 'No active investigation',
        problem: 'code',
        captureIds: [],
        findings: [],
        baselineByMetric: {},
        createdAt: 0,
        updatedAt: 0
      },
      'No active investigation',
      'Inspect a function or choose a problem to begin',
      'search'
    )];
  }
  const target = investigation.findings.find((finding) => finding.id === investigation.targetFindingId);
  return [
    new InvestigationSummaryItem(investigation, investigation.name, investigation.target, 'search'),
    new InvestigationSummaryItem(
      investigation,
      `${investigation.captureIds.length} evidence capture${investigation.captureIds.length === 1 ? '' : 's'}`,
      `${investigation.findings.length} finding${investigation.findings.length === 1 ? '' : 's'}`,
      'pulse'
    ),
    new InvestigationSummaryItem(
      investigation,
      Object.keys(investigation.baselineByMetric).length > 0 ? 'Baseline ready' : 'No verification baseline yet',
      Object.keys(investigation.baselineByMetric).join(', ') || 'Set a baseline from evidence',
      Object.keys(investigation.baselineByMetric).length > 0 ? 'target' : 'circle-large-outline'
    ),
    ...(target ? [new InvestigationSummaryItem(
      investigation,
      `Optimization target: ${target.title}`,
      target.location ? `${target.location.file}:${target.location.line}` : target.detail,
      'pin'
    )] : [])
  ];
}

export class ScenarioItem extends vscode.TreeItem {
  constructor(public readonly scenario: PerformanceScenario) {
    super(scenario.name, vscode.TreeItemCollapsibleState.None);
    const runs = scenario.runs?.length ?? 0;
    this.description = scenario.workloadKind === 'benchmark'
      ? `benchmark · ${runs} run${runs === 1 ? '' : 's'}`
      : `${scenario.problem} · ${scenario.captureSeconds}s · ${runs} run${runs === 1 ? '' : 's'}`;
    this.tooltip = [
      `Problem: ${scenario.problem}`,
      `Target: ${scenario.target ?? 'current target'}`,
      scenario.launchConfiguration ? `Launch: ${scenario.launchConfiguration}` : undefined,
      `Workload: ${scenario.workloadKind}${scenario.workload ? ` · ${scenario.workload}` : ''}`,
      scenario.workloadTaskSource ? `Task source: ${scenario.workloadTaskSource}` : undefined,
      `Warmup: ${scenario.warmupSeconds}s`,
      scenario.workloadKind === 'benchmark'
        ? `Benchmark: count=${scenario.benchmarkCount ?? 5} · benchtime=${scenario.benchmarkTime ?? '1s'}`
        : `Capture: ${scenario.captureKinds.join(', ')} for ${scenario.captureSeconds}s`,
      scenario.successMetrics.length > 0 ? `Metrics: ${scenario.successMetrics.join(', ')}` : undefined
    ].filter(Boolean).join('\n');
    this.iconPath = new vscode.ThemeIcon('run-all');
    this.contextValue = 'gotuneScenario';
    this.command = { command: 'gotune.runScenario', title: 'Run Scenario', arguments: [this] };
  }
}

export class PerformanceTreeProvider<T extends vscode.TreeItem> implements vscode.TreeDataProvider<T> {
  private readonly emitter = new vscode.EventEmitter<T | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly getItems: () => T[]) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: T): vscode.TreeItem {
    return element;
  }

  getChildren(): T[] {
    return this.getItems();
  }
}
