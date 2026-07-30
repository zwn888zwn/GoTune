import * as vscode from 'vscode';
import { Hotspot, ProfileSession } from './model';
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
  configuredContentionProfiles: boolean,
  memoryGrowthSamples = 0
): RunningItem[] {
  if (snapshot.status === 'idle') {
    return [
      new RunningItem('Run current Go main with profiler', undefined, 'run', 'gotune.runWithProfiler'),
      new RunningItem(
        'Contention profiling',
        configuredContentionProfiles ? 'Enabled' : 'Disabled',
        configuredContentionProfiles ? 'check' : 'circle-large-outline',
        'gotune.toggleContentionProfiles'
      )
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
  return [
    new RunningItem(snapshot.target?.importPath ?? 'Go target', `PID ${snapshot.pid ?? '—'}`, 'vm-running'),
    new RunningItem(
      'Contention profiling',
      snapshot.contentionProfilesEnabled ? 'Enabled for this run' : 'Disabled for this run',
      snapshot.contentionProfilesEnabled ? 'check' : 'circle-large-outline',
      'gotune.toggleContentionProfiles'
    ),
    new RunningItem('Live performance overview', 'memory · goroutines · GC', 'dashboard', 'gotune.showRuntimeOverview'),
    new RunningItem('Find CPU hotspots', 'capture while reproducing the slowdown', 'record', 'gotune.captureCpu'),
    new RunningItem(
      'Check memory growth',
      memoryGrowthSamples === 0
        ? 'Step 1/3: capture GC baseline'
        : `Step ${memoryGrowthSamples + 1}/3: repeat workload and capture`,
      'graph',
      'gotune.checkMemoryGrowth'
    ),
    new RunningItem('Snapshot live memory', 'GC first · inuse_space', 'database', 'gotune.captureHeap'),
    new RunningItem('Capture Allocations', 'alloc_space', 'symbol-array', 'gotune.captureAllocations'),
    new RunningItem('Trace execution time', '5s scheduler and blocking timeline', 'history', 'gotune.captureTrace'),
    new RunningItem('Check goroutine leaks', '3 automatic samples', 'list-tree', 'gotune.monitorGoroutines'),
    new RunningItem('Snapshot goroutines', 'current states and stacks', 'list-flat', 'gotune.captureGoroutines'),
    new RunningItem('Capture Mutex', 'sampling must be enabled', 'lock', 'gotune.captureMutex'),
    new RunningItem('Capture Block', 'sampling must be enabled', 'debug-pause', 'gotune.captureBlock'),
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
    this.tooltip = `${stateLabel || 'Session · '}${session.source}\nImported ${new Date(session.importedAt).toLocaleString()}`;
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
