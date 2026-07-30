import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isRuntimeHotspot } from './classify';
import { compareProfiles } from './compare';
import { analyzeEscapes, resolveSourceFile } from './escape';
import { isMainGoSource } from './goSource';
import { GoroutineTracker } from './goroutine';
import { analyzeMemoryTrend } from './memoryTrend';
import { CallNode, Hotspot, ProfileSession, RuntimeMetrics } from './model';
import { listProfileSampleTypes, parseProfile } from './profileParser';
import { buildProfileUrl } from './profileUrl';
import { discoverMainPackages, MainPackage, ProfilerRunner, resolveMainPackage } from './runner';
import { TraceViewer } from './traceViewer';
import { HotspotItem, PerformanceTreeProvider, runningItems, SessionItem } from './views';
import {
  formatValue,
  showComparisonPanel,
  showGoroutineInspector,
  showMemoryTrendPanel,
  showProfilePanel,
  showRuntimeOverviewPanel
} from './webview';

const sessions: ProfileSession[] = [];
let activeSession: ProfileSession | undefined;
let baselineSessionId: string | undefined;
let hideRuntimeFindings = true;
const memoryGrowthSessions: ProfileSession[] = [];

const sessionsStorageKey = 'gotune.sessions.v1';
const activeSessionStorageKey = 'gotune.activeSession.v1';
const baselineStorageKey = 'gotune.baselineSession.v1';

interface RemoteProfileTarget {
  label: string;
  description: string;
  endpoint: string;
}

const remoteProfileTargets: RemoteProfileTarget[] = [
  { label: 'CPU', description: '10 second CPU profile', endpoint: 'profile?seconds=10' },
  { label: 'Heap / Allocations', description: 'Choose in-use or allocation metric after download', endpoint: 'heap' },
  { label: 'Goroutines', description: 'Current goroutine stacks', endpoint: 'goroutine' },
  { label: 'Mutex', description: 'Mutex contention profile', endpoint: 'mutex' },
  { label: 'Block', description: 'Blocking profile', endpoint: 'block' },
  { label: 'Direct profile URL', description: 'Use a concrete profile endpoint without modification', endpoint: '' }
];

class HotspotCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!activeSession) return [];
    return activeSession.hotspots
      .filter((hotspot) => hotspot.location && sameSource(document.uri.fsPath, hotspot.location.file))
      .slice(0, 30)
      .map((hotspot) => {
        const line = Math.max(0, Math.min(document.lineCount - 1, hotspot.location!.line - 1));
        const percent = activeSession!.total === 0 ? 0 : hotspot.cumulative / activeSession!.total * 100;
        return new vscode.CodeLens(document.lineAt(line).range, {
          command: 'gotune.analyzeEscape',
          title: `GoTune: ${percent.toFixed(1)}% cumulative · analyze escapes`,
          arguments: [new HotspotItem(hotspot, activeSession!)]
        });
      });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const savedSessions = context.workspaceState.get<ProfileSession[]>(sessionsStorageKey, []);
  sessions.splice(0, sessions.length, ...savedSessions.filter(isProfileSession));
  baselineSessionId = context.workspaceState.get<string>(baselineStorageKey);
  const activeSessionId = context.workspaceState.get<string>(activeSessionStorageKey);
  activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  if (baselineSessionId && !sessions.some((session) => session.id === baselineSessionId)) {
    baselineSessionId = undefined;
  }

  const diagnostics = vscode.languages.createDiagnosticCollection('gotune');
  const targetOutput = vscode.window.createOutputChannel('GoTune Target');
  const runner = new ProfilerRunner(targetOutput);
  const traceViewer = new TraceViewer(targetOutput);
  let runtimeOverviewPanel: vscode.WebviewPanel | undefined;
  let runtimeOverviewTimer: NodeJS.Timeout | undefined;
  let runtimeOverviewPolling = false;
  const goroutineTracker = new GoroutineTracker();
  const codeLensProvider = new HotspotCodeLensProvider();
  const runningProvider = new PerformanceTreeProvider(() => runningItems(
    runner.snapshot,
    vscode.workspace.getConfiguration('gotune').get<boolean>('enableContentionProfiles', false),
    memoryGrowthSessions.length
  ));
  const sessionProvider = new PerformanceTreeProvider(() => sessions.map((session) => {
    const state = session.id === baselineSessionId
      ? 'baseline'
      : session.id === activeSession?.id ? 'current' : 'normal';
    return new SessionItem(session, state);
  }));
  const findingsProvider = new PerformanceTreeProvider(() =>
    (activeSession?.hotspots ?? [])
      .filter((hotspot) => !hideRuntimeFindings || !isRuntimeHotspot(hotspot))
      .slice(0, 100)
      .map((hotspot) => new HotspotItem(hotspot, activeSession!))
  );
  const heatDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
    borderColor: new vscode.ThemeColor('charts.orange'),
    borderStyle: 'solid',
    borderWidth: '0 0 0 2px',
    overviewRulerColor: new vscode.ThemeColor('charts.orange'),
    overviewRulerLane: vscode.OverviewRulerLane.Right
  });
  const heatLabelDecoration = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 2rem' }
  });

  context.subscriptions.push(
    diagnostics,
    targetOutput,
    runner,
    traceViewer,
    { dispose: closeRuntimeOverview },
    heatDecoration,
    heatLabelDecoration,
    runner.onDidChange((snapshot) => {
      if (snapshot.status === 'idle') {
        goroutineTracker.reset();
        memoryGrowthSessions.splice(0);
        closeRuntimeOverview();
      }
      runningProvider.refresh();
      void vscode.commands.executeCommand('setContext', 'gotune.targetActive', snapshot.status !== 'idle');
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('gotune.enableContentionProfiles')) {
        runningProvider.refresh();
      }
    }),
    vscode.window.registerTreeDataProvider('gotune.running', runningProvider),
    vscode.window.registerTreeDataProvider('gotune.sessions', sessionProvider),
    vscode.window.registerTreeDataProvider('gotune.findings', findingsProvider),
    vscode.commands.registerCommand('gotune.importProfile', async () => {
      const selected = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'pprof profiles': ['pprof', 'pb', 'pb.gz', 'gz'], 'All files': ['*'] },
        openLabel: 'Import Profile'
      });
      if (!selected?.[0]) return;
      try {
        const bytes = Buffer.from(await vscode.workspace.fs.readFile(selected[0]));
        const session = await parseWithSampleChoice(bytes, path.basename(selected[0].fsPath), selected[0].fsPath);
        if (session) addSession(session);
      } catch (error) {
        void vscode.window.showErrorMessage(`GoTune: ${errorMessage(error)}`);
      }
    }),
    vscode.commands.registerCommand(
      'gotune.runWithProfiler',
      async (request?: { skipCurrentEditor?: boolean }) => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage('GoTune: Trust this workspace before running a Go target.');
        return;
      }
      const configuration = vscode.workspace.getConfiguration('gotune');
      const execution = resolveGoExecutionConfiguration();
      let attemptedTarget: MainPackage | undefined;
      try {
        const target = await selectMainPackage(
          execution.goExecutable,
          execution.environment,
          targetOutput,
          request?.skipCurrentEditor ?? false
        );
        if (!target) return;
        attemptedTarget = target;
        const snapshot = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `GoTune: starting ${target.importPath}`,
            cancellable: false
          },
          () => runner.start({
            target,
            goExecutable: execution.goExecutable,
            buildFlags: execution.buildFlags,
            programArguments: configuration.get<string[]>('runArguments', []),
            environment: execution.environment,
            enableContentionProfiles: configuration.get<boolean>('enableContentionProfiles', false)
          })
        );
        const action = await vscode.window.showInformationMessage(
          `GoTune: ${snapshot.target?.importPath} is ready on a protected localhost port.`,
          'Capture CPU',
          'Show Output'
        );
        if (action === 'Capture CPU') {
          void vscode.commands.executeCommand('gotune.captureCpu');
        } else if (action === 'Show Output') {
          targetOutput.show();
        }
      } catch (error) {
        await runner.stop();
        targetOutput.show(true);
        const action = await vscode.window.showErrorMessage(
          `GoTune: ${errorMessage(error)}`,
          ...(attemptedTarget?.fromActiveEditor
            ? ['Choose Another Target', 'Show Output'] as const
            : ['Show Output'] as const)
        );
        if (action === 'Choose Another Target') {
          void vscode.commands.executeCommand('gotune.runWithProfiler', { skipCurrentEditor: true });
        } else if (action === 'Show Output') {
          targetOutput.show();
        }
      }
    }),
    vscode.commands.registerCommand('gotune.stopProfilerTarget', async () => {
      await runner.stop();
    }),
    vscode.commands.registerCommand('gotune.showTargetOutput', () => targetOutput.show()),
    vscode.commands.registerCommand('gotune.toggleContentionProfiles', async () => {
      const configuration = vscode.workspace.getConfiguration('gotune');
      const current = configuration.get<boolean>('enableContentionProfiles', false);
      await configuration.update(
        'enableContentionProfiles',
        !current,
        vscode.ConfigurationTarget.Global
      );
      runningProvider.refresh();
      const restart = runner.snapshot.status !== 'idle'
        ? ' Restart the current target for this change to take effect.'
        : '';
      void vscode.window.showInformationMessage(
        `GoTune: Contention profiling ${!current ? 'enabled' : 'disabled'} in User Settings.${restart}`
      );
    }),
    vscode.commands.registerCommand('gotune.captureCpu', async () => {
      const seconds = vscode.workspace.getConfiguration('gotune').get<number>('captureCpuSeconds', 10);
      void vscode.window.showInformationMessage(
        `GoTune: Reproduce the slow operation now. CPU is being measured for ${seconds} seconds.`
      );
      await captureManagedProfile(`profile?seconds=${seconds}`, 'CPU hotspots', undefined, seconds * 1000 + 15_000);
    }),
    vscode.commands.registerCommand('gotune.showRuntimeOverview', async () => {
      const baseUrl = runner.snapshot.pprofUrl;
      if (runner.snapshot.status !== 'running' || !baseUrl) {
        void vscode.window.showInformationMessage('GoTune: Start a target with Run with Profiler first.');
        return;
      }
      if (runtimeOverviewPanel) {
        runtimeOverviewPanel.reveal(vscode.ViewColumn.Beside);
        return;
      }
      const panel = showRuntimeOverviewPanel((action) => {
        const command = action === 'cpu'
          ? 'gotune.captureCpu'
          : action === 'memory' ? 'gotune.checkMemoryGrowth' : 'gotune.monitorGoroutines';
        void vscode.commands.executeCommand(command);
      });
      runtimeOverviewPanel = panel;
      panel.onDidDispose(() => {
        if (runtimeOverviewPanel === panel) runtimeOverviewPanel = undefined;
        if (runtimeOverviewTimer) clearInterval(runtimeOverviewTimer);
        runtimeOverviewTimer = undefined;
      });
      const refresh = async () => {
        if (runtimeOverviewPolling || runtimeOverviewPanel !== panel) return;
        runtimeOverviewPolling = true;
        try {
          const bytes = await fetchBuffer(buildProfileUrl(baseUrl, '../gotune/runtime'));
          const metrics = parseRuntimeMetrics(bytes);
          await panel.webview.postMessage({ command: 'metrics', metrics });
        } catch (error) {
          targetOutput.appendLine(`[GoTune] Runtime overview update failed: ${errorMessage(error)}`);
        } finally {
          runtimeOverviewPolling = false;
        }
      };
      await refresh();
      runtimeOverviewTimer = setInterval(() => void refresh(), 1000);
    }),
    vscode.commands.registerCommand('gotune.captureHeap', async () => {
      await captureManagedProfile('heap?gc=1', 'Live memory', 'inuse_space');
    }),
    vscode.commands.registerCommand('gotune.checkMemoryGrowth', async () => {
      const sampleNumber = memoryGrowthSessions.length;
      const label = sampleNumber === 0 ? 'Memory baseline' : `Memory round ${sampleNumber}`;
      const session = await captureManagedProfile('heap?gc=1', label, 'inuse_space', undefined, false);
      if (!session) return;
      memoryGrowthSessions.push(session);
      runningProvider.refresh();
      if (memoryGrowthSessions.length < 3) {
        void vscode.window.showInformationMessage(
          memoryGrowthSessions.length === 1
            ? 'GoTune: Baseline captured after GC. Reproduce the suspected leak, then click Check memory growth again.'
            : 'GoTune: Second GC snapshot captured. Repeat the same workload once more, then click Check memory growth.'
        );
        return;
      }
      const trend = analyzeMemoryTrend(memoryGrowthSessions);
      memoryGrowthSessions.splice(0);
      runningProvider.refresh();
      setActive(session);
      showMemoryTrendPanel(
        trend,
        (file, line) => void openSource(file, line, heatDecoration, heatLabelDecoration)
      );
    }),
    vscode.commands.registerCommand('gotune.captureTrace', async () => {
      const baseUrl = runner.snapshot.pprofUrl;
      if (runner.snapshot.status !== 'running' || !baseUrl) {
        void vscode.window.showInformationMessage('GoTune: Start a target with Run with Profiler first.');
        return;
      }
      const seconds = vscode.workspace.getConfiguration('gotune').get<number>('captureTraceSeconds', 5);
      try {
        const execution = resolveGoExecutionConfiguration();
        await traceViewer.ensureAvailable(execution.goExecutable, execution.environment);
        void vscode.window.showInformationMessage(
          `GoTune: Reproduce the slow operation now. Execution is being traced for ${seconds} seconds.`
        );
        const bytes = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `GoTune: tracing execution for ${seconds} seconds`,
            cancellable: false
          },
          () => fetchBuffer(
            buildProfileUrl(baseUrl, `trace?seconds=${seconds}`),
            0,
            seconds * 1000 + 15_000
          )
        );
        const viewerUrl = await traceViewer.open(bytes, execution.goExecutable, execution.environment);
        const externalUrl = await vscode.env.asExternalUri(vscode.Uri.parse(viewerUrl));
        await vscode.env.openExternal(externalUrl);
      } catch (error) {
        targetOutput.show(true);
        void vscode.window.showErrorMessage(
          `GoTune: Could not open execution trace: ${errorMessage(error)}`
        );
      }
    }),
    vscode.commands.registerCommand('gotune.captureAllocations', async () => {
      await captureManagedProfile('allocs', 'Allocations', 'alloc_space');
    }),
    vscode.commands.registerCommand('gotune.captureGoroutines', async () => {
      await inspectGoroutines();
    }),
    vscode.commands.registerCommand('gotune.monitorGoroutines', async () => {
      if (runner.snapshot.status !== 'running' || !runner.snapshot.pprofUrl) {
        void vscode.window.showInformationMessage('GoTune: Start a target with Run with Profiler first.');
        return;
      }
      goroutineTracker.reset();
      void vscode.window.showInformationMessage(
        'GoTune: Reproduce the operation now. Goroutine counts and stable blocking stacks will be sampled three times.'
      );
      try {
        const snapshot = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'GoTune: checking goroutine growth',
            cancellable: true
          },
          async (progress, token) => {
            let latest = await captureGoroutineSnapshot();
            progress.report({ increment: 33, message: 'sample 1/3' });
            for (let index = 1; index < 3; index++) {
              await delay(2000);
              if (token.isCancellationRequested) return undefined;
              latest = await captureGoroutineSnapshot();
              progress.report({ increment: 33, message: `sample ${index + 1}/3` });
            }
            return latest;
          }
        );
        if (!snapshot) return;
        showGoroutineInspector(
          snapshot,
          (file, line) => void openSource(file, line, heatDecoration, heatLabelDecoration, false)
        );
      } catch (error) {
        void vscode.window.showErrorMessage(`GoTune: ${errorMessage(error)}`);
      }
    }),
    vscode.commands.registerCommand('gotune.captureMutex', async () => {
      if (!ensureContentionProfilesEnabled(runner)) return;
      await captureManagedProfile('mutex', 'Mutex');
    }),
    vscode.commands.registerCommand('gotune.captureBlock', async () => {
      if (!ensureContentionProfilesEnabled(runner)) return;
      await captureManagedProfile('block', 'Block');
    }),
    vscode.commands.registerCommand('gotune.fetchProfile', async () => {
      const target = await vscode.window.showQuickPick(
        remoteProfileTargets,
        { title: 'Select pprof Profile Type', placeHolder: 'Profile to capture or download' }
      );
      if (!target) return;
      const value = await vscode.window.showInputBox({
        title: 'Fetch pprof Profile',
        prompt: target.endpoint
          ? 'Enter the pprof server root URL'
          : 'Enter a direct URL that returns pprof protobuf data',
        placeHolder: target.endpoint ? 'http://127.0.0.1:6060' : 'http://127.0.0.1:6060/debug/pprof/heap',
        ignoreFocusOut: true,
        validateInput: (input) => /^https?:\/\//i.test(input) ? undefined : 'Enter an http or https URL'
      });
      if (!value) return;
      try {
        let resolvedTarget = target;
        if (!target.endpoint && isPprofIndexUrl(value)) {
          const concreteTarget = await vscode.window.showQuickPick(
            remoteProfileTargets.filter((candidate) => candidate.endpoint),
            {
              title: 'The entered URL is the pprof index',
              placeHolder: 'Choose the concrete profile to fetch'
            }
          );
          if (!concreteTarget) return;
          resolvedTarget = concreteTarget;
        }
        const profileUrl = buildProfileUrl(value, resolvedTarget.endpoint);
        const bytes = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GoTune: fetching profile', cancellable: false },
          () => fetchBuffer(profileUrl)
        );
        const remoteName = new URL(profileUrl).pathname.split('/').filter(Boolean).at(-1) || 'Remote profile';
        const session = await parseWithSampleChoice(bytes, remoteName, profileUrl);
        if (session) addSession(session);
      } catch (error) {
        void vscode.window.showErrorMessage(`GoTune: ${errorMessage(error)}`);
      }
    }),
    vscode.commands.registerCommand('gotune.showProfile', (item?: SessionItem) => {
      if (item?.session) {
        setActive(item.session);
      }
      if (!activeSession) {
        void vscode.window.showInformationMessage('GoTune: Import or fetch a profile first.');
        return;
      }
      showProfilePanel(activeSession, (file, line) => void openSource(file, line, heatDecoration, heatLabelDecoration));
    }),
    vscode.commands.registerCommand('gotune.showSource', async (item?: HotspotItem) => {
      const hotspot = item?.hotspot;
      if (!hotspot?.location) return;
      await openSource(hotspot.location.file, hotspot.location.line, heatDecoration, heatLabelDecoration);
    }),
    vscode.commands.registerCommand('gotune.analyzeEscape', async (item?: HotspotItem) => {
      const hotspot = item?.hotspot ?? hotspotAtEditor();
      await analyzeEscapes(hotspot, activeSession, diagnostics);
    }),
    vscode.commands.registerCommand('gotune.toggleRuntimeFindings', () => {
      hideRuntimeFindings = !hideRuntimeFindings;
      updateContexts();
      findingsProvider.refresh();
      void vscode.window.showInformationMessage(
        `GoTune: Runtime findings are now ${hideRuntimeFindings ? 'hidden' : 'visible'}.`
      );
    }),
    vscode.commands.registerCommand('gotune.setBaseline', (item?: SessionItem) => {
      const session = item?.session ?? activeSession;
      if (!session) {
        void vscode.window.showInformationMessage('GoTune: Import or select a profile first.');
        return;
      }
      baselineSessionId = session.id;
      persist();
      updateContexts();
      sessionProvider.refresh();
      void vscode.window.showInformationMessage(`GoTune: ${session.name} is now the baseline.`);
    }),
    vscode.commands.registerCommand('gotune.compareWithBaseline', (item?: SessionItem) => {
      if (item?.session) {
        setActive(item.session);
      }
      const baseline = sessions.find((session) => session.id === baselineSessionId);
      if (!baseline || !activeSession) {
        void vscode.window.showInformationMessage('GoTune: Set a baseline and select a current profile first.');
        return;
      }
      if (baseline.id === activeSession.id) {
        void vscode.window.showInformationMessage('GoTune: Select another session to compare with the baseline.');
        return;
      }
      try {
        const comparison = compareProfiles(baseline, activeSession);
        showComparisonPanel(
          comparison,
          (file, line) => void openSource(file, line, heatDecoration, heatLabelDecoration)
        );
      } catch (error) {
        void vscode.window.showWarningMessage(`GoTune: ${errorMessage(error)}`);
      }
    }),
    vscode.commands.registerCommand('gotune.clearSessions', () => {
      sessions.splice(0);
      activeSession = undefined;
      baselineSessionId = undefined;
      diagnostics.clear();
      for (const editor of vscode.window.visibleTextEditors) {
        editor.setDecorations(heatDecoration, []);
        editor.setDecorations(heatLabelDecoration, []);
      }
      persist();
      updateContexts();
      sessionProvider.refresh();
      findingsProvider.refresh();
      codeLensProvider.refresh();
    }),
    vscode.languages.registerCodeLensProvider({ language: 'go', scheme: 'file' }, codeLensProvider)
  );
  updateContexts();
  void vscode.commands.executeCommand('setContext', 'gotune.targetActive', false);

  function addSession(session: ProfileSession, showResult = true): void {
    sessions.unshift(session);
    setActive(session);
    persist();
    sessionProvider.refresh();
    findingsProvider.refresh();
    if (showResult) void vscode.commands.executeCommand('gotune.showProfile');
  }

  function setActive(session: ProfileSession): void {
    activeSession = session;
    persist();
    updateContexts();
    sessionProvider.refresh();
    findingsProvider.refresh();
    codeLensProvider.refresh();
  }

  function hotspotAtEditor(): Hotspot | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !activeSession) return undefined;
    const line = editor.selection.active.line + 1;
    return activeSession.hotspots
      .filter((hotspot) => hotspot.location && sameSource(editor.document.uri.fsPath, hotspot.location.file))
      .sort((left, right) => Math.abs((left.location?.line ?? 0) - line) - Math.abs((right.location?.line ?? 0) - line))[0];
  }

  function updateContexts(): void {
    void vscode.commands.executeCommand('setContext', 'gotune.hasActiveProfile', Boolean(activeSession));
    void vscode.commands.executeCommand('setContext', 'gotune.hasBaseline', Boolean(baselineSessionId));
    void vscode.commands.executeCommand('setContext', 'gotune.hideRuntimeFindings', hideRuntimeFindings);
  }

  function persist(): void {
    const compactSessions = sessions.slice(0, 8).map(compactSession);
    void context.workspaceState.update(sessionsStorageKey, compactSessions);
    void context.workspaceState.update(activeSessionStorageKey, activeSession?.id);
    void context.workspaceState.update(baselineStorageKey, baselineSessionId);
  }

  async function parseWithSampleChoice(
    bytes: Buffer,
    name: string,
    source: string
  ): Promise<ProfileSession | undefined> {
    const sampleTypes = listProfileSampleTypes(bytes);
    const allocationTypes = sampleTypes.filter((type) => /^(?:inuse|alloc)_/.test(type.name));
    let selectedType: string | undefined;
    if (allocationTypes.length > 1) {
      const selected = await vscode.window.showQuickPick(
        [...allocationTypes]
          .sort((left, right) => Number(right.isDefault) - Number(left.isDefault))
          .map((type) => ({
            label: type.name,
            description: type.unit,
            detail: type.isDefault ? 'Default metric' : undefined,
            sampleType: type.name
          })),
        {
          title: 'Select Profile Metric',
          placeHolder: 'Choose how this heap profile should be aggregated'
        }
      );
      if (!selected) return undefined;
      selectedType = selected.sampleType;
    }
    return parseProfile(bytes, name, source, selectedType);
  }

  async function captureManagedProfile(
    endpoint: string,
    label: string,
    preferredSampleType?: string,
    timeoutMs?: number,
    showResult = true
  ): Promise<ProfileSession | undefined> {
    const baseUrl = runner.snapshot.pprofUrl;
    if (runner.snapshot.status !== 'running' || !baseUrl) {
      void vscode.window.showInformationMessage('GoTune: Start a target with Run with Profiler first.');
      return undefined;
    }
    const profileUrl = buildProfileUrl(baseUrl, endpoint);
    try {
      const bytes = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `GoTune: capturing ${label}`,
          cancellable: false
        },
        () => fetchBuffer(profileUrl, 0, timeoutMs)
      );
      const timestamp = new Date().toLocaleTimeString();
      const session = parseProfile(bytes, `${label} ${timestamp}`, profileUrl, preferredSampleType);
      addSession(session, showResult);
      if (session.sampleType === 'cpu' && session.total === 0) {
        void vscode.window.showWarningMessage(
          'GoTune: No CPU samples were recorded. The target was idle; generate workload during the capture window.'
        );
      }
      return session;
    } catch (error) {
      void vscode.window.showErrorMessage(`GoTune: ${errorMessage(error)}`);
      return undefined;
    }
  }

  async function inspectGoroutines(): Promise<void> {
    if (runner.snapshot.status !== 'running' || !runner.snapshot.pprofUrl) {
      void vscode.window.showInformationMessage('GoTune: Start a target with Run with Profiler first.');
      return;
    }
    try {
      const snapshot = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'GoTune: inspecting goroutines',
          cancellable: false
        },
        () => captureGoroutineSnapshot()
      );
      showGoroutineInspector(
        snapshot,
        (file, line) => void openSource(file, line, heatDecoration, heatLabelDecoration, false)
      );
      if (snapshot.suspiciousCount > 0) {
        void vscode.window.showWarningMessage(
          `GoTune: ${snapshot.suspiciousCount} goroutine(s) remained in suspicious blocking stacks.`
        );
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`GoTune: ${errorMessage(error)}`);
    }
  }

  async function captureGoroutineSnapshot() {
    const baseUrl = runner.snapshot.pprofUrl;
    if (!baseUrl) throw new Error('The profiler target is not running');
    const bytes = await fetchBuffer(buildProfileUrl(baseUrl, 'goroutine?debug=2'));
    return goroutineTracker.capture(bytes.toString('utf8'));
  }

  function closeRuntimeOverview(): void {
    if (runtimeOverviewTimer) clearInterval(runtimeOverviewTimer);
    runtimeOverviewTimer = undefined;
    const panel = runtimeOverviewPanel;
    runtimeOverviewPanel = undefined;
    panel?.dispose();
  }
}

async function openSource(
  filename: string,
  line: number,
  heatDecoration: vscode.TextEditorDecorationType,
  heatLabelDecoration: vscode.TextEditorDecorationType,
  applyProfileHeat = true
): Promise<void> {
  const uri = await resolveSourceFile(filename);
  if (!uri) {
    void vscode.window.showWarningMessage(`GoTune: Could not map profile source ${filename} to this workspace.`);
    return;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: true });
  const targetLine = Math.max(0, Math.min(document.lineCount - 1, line - 1));
  const position = new vscode.Position(targetLine, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  if (!applyProfileHeat) {
    editor.setDecorations(heatDecoration, []);
    editor.setDecorations(heatLabelDecoration, []);
    return;
  }

  const metrics = activeSession?.lineMetrics.filter((metric) => sameSource(uri.fsPath, metric.file)) ?? [];
  const max = Math.max(...metrics.map((metric) => metric.value), 1);
  const lineDecorations = metrics.map((metric) => {
    const metricLine = Math.max(0, Math.min(document.lineCount - 1, metric.line - 1));
    const percent = activeSession?.total ? metric.value / activeSession.total * 100 : 0;
    return {
      range: document.lineAt(metricLine).range,
      hoverMessage: `$(flame) **${metric.functionName}**\n\n${formatValue(metric.value, activeSession?.sampleUnit ?? '')} (${percent.toFixed(1)}% of profile)`
    };
  });
  const labels = metrics.map((metric) => {
    const metricLine = Math.max(0, Math.min(document.lineCount - 1, metric.line - 1));
    const percent = activeSession?.total ? metric.value / activeSession.total * 100 : 0;
    const lineRange = document.lineAt(metricLine).range;
    return {
      range: new vscode.Range(lineRange.end, lineRange.end),
      renderOptions: {
        after: { contentText: ` GoTune ${percent.toFixed(1)}%`, opacity: String(0.45 + 0.55 * metric.value / max) }
      }
    };
  });
  editor.setDecorations(heatDecoration, lineDecorations);
  editor.setDecorations(heatLabelDecoration, labels);
}

function sameSource(left: string, right: string): boolean {
  const normalize = (value: string) => value.replaceAll('\\', '/');
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function fetchBuffer(url: string, redirects = 0, timeoutOverrideMs?: number): Promise<Buffer> {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  const timeout = timeoutOverrideMs
    ?? vscode.workspace.getConfiguration('gotune').get<number>('fetchTimeoutSeconds', 45) * 1000;
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { headers: { Accept: 'application/octet-stream', 'User-Agent': 'GoTune/0.2' } }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(fetchBuffer(new URL(response.headers.location, url).toString(), redirects + 1, timeoutOverrideMs));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Profile server returned HTTP ${response.statusCode}`));
        return;
      }
      const contentType = response.headers['content-type'] ?? '';
      if (contentType.includes('text/html')) {
        response.resume();
        reject(new Error(
          'The server returned the HTML pprof index. Choose CPU, Heap, or use a direct /debug/pprof/<profile> URL.'
        ));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 100 * 1024 * 1024) {
          request.destroy(new Error('Profile is larger than the 100 MiB download limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.setTimeout(timeout, () => request.destroy(new Error(`Profile request timed out after ${timeout / 1000}s`)));
    request.on('error', reject);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRuntimeMetrics(bytes: Buffer): RuntimeMetrics {
  const value = JSON.parse(bytes.toString('utf8')) as Partial<RuntimeMetrics>;
  const fields: (keyof RuntimeMetrics)[] = [
    'timestamp',
    'heapAlloc',
    'heapObjects',
    'totalAlloc',
    'numGC',
    'pauseTotalNs',
    'goroutines'
  ];
  if (fields.some((field) => typeof value[field] !== 'number')) {
    throw new Error('Profiler returned invalid runtime metrics');
  }
  return value as RuntimeMetrics;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ensureContentionProfilesEnabled(runner: ProfilerRunner): boolean {
  if (runner.snapshot.contentionProfilesEnabled) return true;
  void vscode.window.showInformationMessage(
    'GoTune: Contention profiling is disabled for this run. Toggle it in Running, then restart the target.'
  );
  return false;
}

async function selectMainPackage(
  goExecutable: string,
  environment: Record<string, string>,
  output: vscode.OutputChannel,
  skipCurrentEditor: boolean
): Promise<MainPackage | undefined> {
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (
    !skipCurrentEditor
    &&
    activeDocument?.languageId === 'go'
    && activeDocument.uri.scheme === 'file'
    && isMainGoSource(activeDocument.getText())
  ) {
    if (activeDocument.isDirty && !await activeDocument.save()) {
      throw new Error('The current main file could not be saved before running');
    }
    const currentDirectory = path.dirname(activeDocument.uri.fsPath);
    output.appendLine(`[GoTune] Current editor is package main: ${activeDocument.uri.fsPath}`);
    const currentPackage = await resolveMainPackage(goExecutable, currentDirectory, environment, output);
    if (currentPackage) {
      output.appendLine(`[GoTune] Using current main package: ${currentPackage.importPath}`);
      return { ...currentPackage, fromActiveEditor: true };
    }
    output.appendLine('[GoTune] go list could not resolve the current main; running its directory directly.');
    return {
      importPath: path.basename(currentDirectory),
      directory: currentDirectory,
      fromActiveEditor: true
    };
  }

  const workspaceDirectories = (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => folder.uri.fsPath);
  let packages = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'GoTune: discovering Go main packages',
      cancellable: false
    },
    () => discoverMainPackages(goExecutable, workspaceDirectories, environment, output)
  );
  if (packages.length === 0) {
    const selected = await vscode.window.showOpenDialog({
      title: 'Select a Go module or main package directory',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Find main packages'
    });
    if (!selected?.[0]) return undefined;
    packages = await discoverMainPackages(goExecutable, [selected[0].fsPath], environment, output);
  }
  if (packages.length === 0) {
    throw new Error('No Go main package was found. Open or select a directory containing package main.');
  }
  if (packages.length === 1) return packages[0];
  const selected = await vscode.window.showQuickPick(
    packages.map((candidate) => ({
      label: candidate.importPath,
      description: candidate.directory,
      target: candidate
    })),
    {
      title: 'Run with Profiler',
      placeHolder: 'Select the Go main package to run'
    }
  );
  return selected?.target;
}

interface GoExecutionConfiguration {
  goExecutable: string;
  environment: Record<string, string>;
  buildFlags: string[];
}

function resolveGoExecutionConfiguration(): GoExecutionConfiguration {
  const gotune = vscode.workspace.getConfiguration('gotune');
  const go = vscode.workspace.getConfiguration('go');
  const configuredExecutable = gotune.get<string>('goExecutable', 'go');
  const alternateTools = go.get<Record<string, string>>('alternateTools', {});
  const goroot = go.get<string>('goroot');
  const goExecutable = configuredExecutable !== 'go'
    ? configuredExecutable
    : alternateTools.go || (goroot ? path.join(goroot, 'bin', 'go') : 'go');

  const environment = {
    ...go.get<Record<string, string>>('toolsEnvVars', {}),
    ...gotune.get<Record<string, string>>('runEnvironment', {})
  };
  const gopath = go.get<string>('gopath');
  if (goroot && !environment.GOROOT) environment.GOROOT = goroot;
  if (gopath && !environment.GOPATH) environment.GOPATH = gopath;

  return {
    goExecutable,
    environment,
    buildFlags: [
      ...go.get<string[]>('buildFlags', []),
      ...gotune.get<string[]>('runBuildFlags', [])
    ]
  };
}

function isPprofIndexUrl(value: string): boolean {
  try {
    const pathname = new URL(value).pathname.replace(/\/+$/, '');
    return pathname.endsWith('/debug/pprof');
  } catch {
    return false;
  }
}

function compactSession(session: ProfileSession): ProfileSession {
  const budget = { remaining: 3000 };
  return {
    ...session,
    hotspots: session.hotspots.slice(0, 500),
    lineMetrics: [...session.lineMetrics].sort((left, right) => right.value - left.value).slice(0, 2000),
    callTree: compactCallTree(session.callTree, budget)
  };
}

function compactCallTree(nodes: CallNode[], budget: { remaining: number }): CallNode[] {
  const result: CallNode[] = [];
  for (const node of nodes) {
    if (budget.remaining <= 0) break;
    budget.remaining--;
    result.push({ ...node, children: compactCallTree(node.children, budget) });
  }
  return result;
}

function isProfileSession(value: unknown): value is ProfileSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<ProfileSession>;
  return typeof session.id === 'string'
    && typeof session.name === 'string'
    && typeof session.sampleType === 'string'
    && typeof session.sampleUnit === 'string'
    && typeof session.total === 'number'
    && Array.isArray(session.hotspots)
    && Array.isArray(session.callTree)
    && Array.isArray(session.lineMetrics);
}

export function deactivate(): void {}
