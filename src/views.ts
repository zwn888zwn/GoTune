import * as vscode from 'vscode';
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
  memoryGrowthSamples = 0,
  advancedToolsVisible = false
): RunningItem[] {
  if (snapshot.status === 'idle') {
    return [
      new RunningItem('Investigate a performance problem', 'choose the symptom; GoTune selects evidence', 'search', 'gotune.startInvestigation'),
      new RunningItem('Run current Go main with profiler', 'use the active package main when possible', 'run', 'gotune.runWithProfiler'),
      new RunningItem('Run launch.json with profiler', 'reuse project environment, arguments, and debug setup', 'debug-start', 'gotune.runLaunchWithProfiler'),
      new RunningItem('Connect to a pprof server', 'for an already running Go process', 'plug', 'gotune.fetchProfile'),
      new RunningItem('Import an existing profile', 'open a .pprof or protobuf file', 'folder-opened', 'gotune.importProfile')
    ];
  }
  if (snapshot.status === 'starting') {
    return [
      new RunningItem('Starting profiler target…', snapshot.target?.importPath, 'loading~spin'),
      new RunningItem('Show target output', undefined, 'output', 'gotune.showTargetOutput')
    ];
  }
  if (snapshot.status === 'stopping') {
    return [new RunningItem('Stopping profiler target…', snapshot.target?.importPath, 'loading~spin')];
  }
  const primary = [
    new RunningItem(snapshot.target?.importPath ?? 'Go target', `PID ${snapshot.pid ?? '—'}`, 'vm-running'),
    new RunningItem('CPU high or operation slow', 'capture while reproducing the slowdown', 'flame', 'gotune.captureCpu'),
    new RunningItem(
      'Memory keeps growing',
      memoryGrowthSamples === 0
        ? 'Step 1/3: capture GC baseline'
        : `Step ${memoryGrowthSamples + 1}/3: repeat workload and capture`,
      'graph',
      'gotune.checkMemoryGrowth'
    ),
    new RunningItem('Too many allocations or GC pressure', 'find code creating the most temporary objects', 'symbol-array', 'gotune.captureAllocations'),
    new RunningItem('Request stuck or goroutines blocked', 'sample repeated stacks and check progress', 'list-tree', 'gotune.monitorGoroutines'),
    new RunningItem(
      advancedToolsVisible ? 'Hide advanced diagnostics' : 'Show advanced diagnostics',
      advancedToolsVisible ? 'trace · goroutines · contention' : 'Only needed for blocking or scheduler problems',
      advancedToolsVisible ? 'chevron-up' : 'chevron-down',
      'gotune.toggleAdvancedTools'
    )
  ];
  const advanced = advancedToolsVisible ? [
    new RunningItem('Live performance overview', 'memory · goroutines · GC', 'dashboard', 'gotune.showRuntimeOverview'),
    new RunningItem('Raw live memory snapshot', 'GC first · inuse_space', 'database', 'gotune.captureHeap'),
    new RunningItem('Trace execution time', '5s scheduler and blocking timeline', 'history', 'gotune.captureTrace'),
    new RunningItem('Snapshot goroutines', 'current states and stacks', 'list-flat', 'gotune.captureGoroutines'),
    new RunningItem(
      'Contention profiling',
      snapshot.contentionProfilesEnabled ? 'Enabled for this run' : 'Disabled for this run',
      snapshot.contentionProfilesEnabled ? 'check' : 'circle-large-outline',
      'gotune.toggleContentionProfiles'
    ),
    new RunningItem('Capture Mutex', 'sampling must be enabled', 'lock', 'gotune.captureMutex'),
    new RunningItem('Capture Block', 'sampling must be enabled', 'debug-pause', 'gotune.captureBlock')
  ] : [];
  return [
    ...primary,
    ...advanced,
    new RunningItem('Show target output', undefined, 'output', 'gotune.showTargetOutput'),
    new RunningItem('Stop target', undefined, 'debug-stop', 'gotune.stopProfilerTarget')
  ];
}

export class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly session: ProfileSession,
    state: 'baseline' | 'current' | 'normal' = 'normal'
  ) {
    super(session.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'gotuneSession';
    const stateLabel = state === 'baseline' ? 'Baseline · ' : state === 'current' ? 'Current · ' : '';
    this.description = `${stateLabel}${session.sampleType} · ${formatValue(session.total, session.sampleUnit)}`;
    this.tooltip = [
      `${stateLabel || 'Session · '}${session.source}`,
      session.target ? `Target: ${session.target}` : undefined,
      session.captureDurationMs ? `Capture: ${session.captureDurationMs / 1000}s` : undefined,
      `Captured ${new Date(session.importedAt).toLocaleString()}`
    ].filter(Boolean).join('\n');
    this.iconPath = new vscode.ThemeIcon(
      state === 'baseline' ? 'target' : state === 'current' ? 'arrow-right' : 'pulse'
    );
    this.command = { command: 'gotune.showProfile', title: 'Show Profile', arguments: [this] };
  }
}

export class HotspotItem extends vscode.TreeItem {
  constructor(public readonly hotspot: Hotspot, session: ProfileSession) {
    super(hotspot.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'gotuneHotspot';
    const percent = session.total === 0 ? 0 : hotspot.cumulative / session.total * 100;
    this.description = `${percent.toFixed(1)}% cumulative`;
    this.tooltip = [
      `Flat: ${formatValue(hotspot.flat, session.sampleUnit)}`,
      `Cumulative: ${formatValue(hotspot.cumulative, session.sampleUnit)}`,
      hotspot.location ? `${hotspot.location.file}:${hotspot.location.line}` : 'No source location'
    ].join('\n');
    this.iconPath = new vscode.ThemeIcon(hotspot.location ? 'flame' : 'symbol-method');
    if (hotspot.location) {
      this.command = { command: 'gotune.showSource', title: 'Open Source', arguments: [this] };
    }
  }
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
