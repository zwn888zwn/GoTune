import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { compareProfiles } from './compare';
import { analyzeEscapes, resolveSourceFile } from './escape';
import { collectFunctionEvidence, findFunctionHotspot } from './functionEvidence';
import { showFunctionEvidencePanel } from './functionEvidenceView';
import { isMainGoSource } from './goSource';
import { GoroutineTracker } from './goroutine';
import {
  addCaptureToInvestigation,
  addFindingsToInvestigation,
  createInvestigation,
  evidenceKind as profileEvidenceKind,
  findingsFromComparison,
  findingsFromGoroutines,
  findingsFromMemoryTrend,
  problemForSampleType
} from './investigation';
import { analyzeMemoryTrend } from './memoryTrend';
import {
  CallNode,
  EvidenceKind,
  GoFunctionReference,
  Hotspot,
  Investigation,
  PerformanceFinding,
  PerformanceScenario,
  ProblemKind,
  ProfileSession,
  RuntimeMetrics
} from './model';
import { listProfileSampleTypes, parseProfile } from './profileParser';
import { buildProfileUrl } from './profileUrl';
import { discoverMainPackages, MainPackage, ProfilerRunner, resolveMainPackage } from './runner';
import { TraceViewer } from './traceViewer';
import {
  HotspotItem,
  InvestigationFindingItem,
  investigationItems,
  PerformanceTreeProvider,
  runningItems,
  ScenarioItem,
  SessionItem
} from './views';
import {
  formatValue,
  showComparisonPanel,
  showGoroutineInspector,
  showMemoryTrendPanel,
  showProfilePanel,
  showRuntimeOverviewPanel
} from './webview';

const sessions: ProfileSession[] = [];
const investigations: Investigation[] = [];
const scenarios: PerformanceScenario[] = [];
let activeSession: ProfileSession | undefined;
let baselineSessionId: string | undefined;
let activeInvestigationId: string | undefined;
const memoryGrowthSessions: ProfileSession[] = [];

const sessionsStorageKey = 'gotune.sessions.v1';
const activeSessionStorageKey = 'gotune.activeSession.v1';
const baselineStorageKey = 'gotune.baselineSession.v1';
const advancedToolsStorageKey = 'gotune.advancedToolsVisible.v1';
const investigationsStorageKey = 'gotune.investigations.v1';
const activeInvestigationStorageKey = 'gotune.activeInvestigation.v1';
const scenariosStorageKey = 'gotune.scenarios.v1';

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
        const flatPercent = activeSession!.total === 0 ? 0 : hotspot.flat / activeSession!.total * 100;
        const cumulativePercent = activeSession!.total === 0 ? 0 : hotspot.cumulative / activeSession!.total * 100;
        const allocation = /^alloc_/.test(activeSession!.sampleType);
        return new vscode.CodeLens(document.lineAt(line).range, {
          command: allocation ? 'gotune.analyzeEscape' : 'gotune.showCurrentFunctionInProfile',
          title: allocation
            ? `GoTune Alloc: ${formatValue(hotspot.flat, activeSession!.sampleUnit)} self · analyze escapes`
            : `GoTune ${profileKindLabel(activeSession!.sampleType)}: ${flatPercent.toFixed(1)}% self · ${cumulativePercent.toFixed(1)}% with callees`,
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
  const savedInvestigations = context.workspaceState.get<Investigation[]>(investigationsStorageKey, []);
  investigations.splice(0, investigations.length, ...savedInvestigations.filter(isInvestigation));
  const savedScenarios = context.workspaceState.get<PerformanceScenario[]>(scenariosStorageKey, []);
  scenarios.splice(0, scenarios.length, ...savedScenarios.filter(isPerformanceScenario));
  activeInvestigationId = context.workspaceState.get<string>(activeInvestigationStorageKey);
  if (activeInvestigationId && !investigations.some((item) => item.id === activeInvestigationId)) {
    activeInvestigationId = undefined;
  }
  if (baselineSessionId && !sessions.some((session) => session.id === baselineSessionId)) {
    baselineSessionId = undefined;
  }
  if (investigations.length === 0 && sessions.length > 0) {
    for (const session of [...sessions].reverse()) {
      const problem = problemForSampleType(session.sampleType);
      const existing = investigations.find((item) =>
        item.problem === problem && item.target === session.target
      );
      const investigation = existing ?? createInvestigation(problem, session.target, session.importedAt);
      const updated = addCaptureToInvestigation(investigation, session, session.importedAt);
      if (existing) {
        investigations[investigations.indexOf(existing)] = updated;
      } else {
        investigations.unshift(updated);
      }
    }
    activeInvestigationId = investigations.find((item) =>
      item.captureIds.includes(activeSession?.id ?? '')
    )?.id ?? investigations[0]?.id;
  }

  const diagnostics = vscode.languages.createDiagnosticCollection('gotune');
  const targetOutput = vscode.window.createOutputChannel('GoTune Target');
  const runner = new ProfilerRunner(targetOutput);
  const traceViewer = new TraceViewer(targetOutput);
  let advancedToolsVisible = context.workspaceState.get<boolean>(advancedToolsStorageKey, false);
  let runtimeOverviewPanel: vscode.WebviewPanel | undefined;
  let runtimeOverviewTimer: NodeJS.Timeout | undefined;
  let runtimeOverviewPolling = false;
  const goroutineTracker = new GoroutineTracker();
  const codeLensProvider = new HotspotCodeLensProvider();
  const runningProvider = new PerformanceTreeProvider(() => runningItems(
    runner.snapshot,
    memoryGrowthSessions.length,
    advancedToolsVisible
  ));
  const sessionProvider = new PerformanceTreeProvider(() => sessions.map((session) => {
    const state = session.id === baselineSessionId
      ? 'baseline'
      : session.id === activeSession?.id ? 'current' : 'normal';
    return new SessionItem(session, state);
  }));
  const investigationProvider = new PerformanceTreeProvider(() =>
    investigationItems(currentInvestigation())
  );
  const scenarioProvider = new PerformanceTreeProvider(() =>
    scenarios.map((scenario) => new ScenarioItem(scenario))
  );
  const findingsProvider = new PerformanceTreeProvider(() => {
    const investigation = currentInvestigation();
    if (!investigation) return [];
    return investigation.findings.map((finding) => new InvestigationFindingItem(
      finding,
      sessions.find((session) => session.id === finding.captureId)
    ));
  });
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
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.languageId === 'go') {
        applyProfileHeatToEditor(editor, heatDecoration, heatLabelDecoration);
      }
    }),
    vscode.window.registerTreeDataProvider('gotune.running', runningProvider),
    vscode.window.registerTreeDataProvider('gotune.investigation', investigationProvider),
    vscode.window.registerTreeDataProvider('gotune.scenarios', scenarioProvider),
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
    vscode.commands.registerCommand('gotune.toggleAdvancedTools', () => {
      advancedToolsVisible = !advancedToolsVisible;
      void context.workspaceState.update(advancedToolsStorageKey, advancedToolsVisible);
      runningProvider.refresh();
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
      const investigation = currentInvestigation();
      if (investigation) {
        replaceInvestigation(addFindingsToInvestigation(
          investigation,
          findingsFromMemoryTrend(investigation.id, trend),
          'memory-trend-'
        ));
      }
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
      const investigation = ensureInvestigation('blocking', runner.snapshot.target?.importPath);
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
        replaceInvestigation(addFindingsToInvestigation(
          investigation,
          findingsFromGoroutines(investigation.id, snapshot),
          'goroutine-'
        ));
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
      showSessionProfile(activeSession);
    }),
    vscode.commands.registerCommand('gotune.showCurrentFunctionInProfile', async (item?: HotspotItem) => {
      if (!activeSession) {
        void vscode.window.showInformationMessage('GoTune: Capture or import a profile first.');
        return;
      }
      const hotspot = item?.hotspot ?? await hotspotAtEditor();
      if (!hotspot) {
        void vscode.window.showInformationMessage(
          'GoTune: The current function has no samples in the active profile.'
        );
        return;
      }
      showSessionProfile(activeSession, hotspot);
    }),
    vscode.commands.registerCommand('gotune.inspectCurrentFunction', async () => {
      const fn = await functionAtEditor();
      if (!fn) {
        void vscode.window.showInformationMessage('GoTune: Put the cursor inside a Go function first.');
        return;
      }
      ensureInvestigation('code', runner.snapshot.target?.importPath);
      const report = collectFunctionEvidence(fn, sessions, baselineSessionId);
      showFunctionEvidencePanel(report, (action) => {
        if (action.command === 'open-source') {
          void openSource(fn.file, fn.startLine, heatDecoration, heatLabelDecoration);
          return;
        }
        if (action.command === 'capture') {
          const command = action.kind === 'cpu'
            ? 'gotune.captureCpu'
            : action.kind === 'allocation' ? 'gotune.captureAllocations' : 'gotune.captureHeap';
          void captureEvidenceForCurrentFunction(command);
          return;
        }
        const session = sessions.find((candidate) => candidate.id === action.sessionId);
        if (!session) return;
        const hotspot = findFunctionHotspot(fn, session);
        setActive(session);
        if (action.command === 'analyze-escape') {
          void vscode.commands.executeCommand(
            'gotune.analyzeEscape',
            hotspot ? new HotspotItem(hotspot, session) : undefined
          );
        } else {
          showSessionProfile(session, hotspot);
        }
      });
    }),
    vscode.commands.registerCommand('gotune.createScenario', async () => {
      const scenario = await promptForScenario();
      if (!scenario) return;
      scenarios.unshift(scenario);
      persist();
      scenarioProvider.refresh();
      void vscode.window.showInformationMessage(`GoTune: Saved scenario "${scenario.name}".`);
    }),
    vscode.commands.registerCommand('gotune.runScenario', async (item?: ScenarioItem) => {
      const scenario = item?.scenario ?? await pickScenario();
      if (!scenario) return;
      try {
        await runScenario(scenario);
      } catch (error) {
        void vscode.window.showErrorMessage(`GoTune: ${errorMessage(error)}`);
      }
    }),
    vscode.commands.registerCommand('gotune.deleteScenario', async (item?: ScenarioItem) => {
      const scenario = item?.scenario ?? await pickScenario();
      if (!scenario) return;
      const confirmation = await vscode.window.showWarningMessage(
        `Delete performance scenario "${scenario.name}"?`,
        { modal: true },
        'Delete'
      );
      if (confirmation !== 'Delete') return;
      const index = scenarios.findIndex((candidate) => candidate.id === scenario.id);
      if (index < 0) return;
      scenarios.splice(index, 1);
      persist();
      scenarioProvider.refresh();
    }),
    vscode.commands.registerCommand('gotune.showSource', async (item?: { hotspot?: Hotspot }) => {
      const hotspot = item?.hotspot;
      if (!hotspot?.location) return;
      await openSource(hotspot.location.file, hotspot.location.line, heatDecoration, heatLabelDecoration);
    }),
    vscode.commands.registerCommand('gotune.showFindingSource', async (finding?: PerformanceFinding) => {
      if (!finding?.location) return;
      const session = sessions.find((candidate) => candidate.id === finding.captureId);
      if (session) setActive(session);
      await openSource(
        finding.location.file,
        finding.location.line,
        heatDecoration,
        heatLabelDecoration
      );
    }),
    vscode.commands.registerCommand('gotune.analyzeEscape', async (item?: HotspotItem) => {
      const hotspot = item?.hotspot ?? await hotspotAtEditor();
      const execution = resolveGoExecutionConfiguration();
      await analyzeEscapes(
        hotspot,
        activeSession,
        diagnostics,
        execution.goExecutable,
        execution.environment,
        execution.buildFlags
      );
    }),
    vscode.commands.registerCommand('gotune.setBaseline', (item?: SessionItem) => {
      const session = item?.session ?? activeSession;
      if (!session) {
        void vscode.window.showInformationMessage('GoTune: Import or select a profile first.');
        return;
      }
      baselineSessionId = session.id;
      const investigation = currentInvestigation();
      if (investigation) {
        investigation.baselineByMetric[sessionMetricKey(session)] = session.id;
        investigation.updatedAt = Date.now();
      }
      persist();
      updateContexts();
      sessionProvider.refresh();
      investigationProvider.refresh();
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
      investigations.splice(0);
      activeSession = undefined;
      baselineSessionId = undefined;
      activeInvestigationId = undefined;
      diagnostics.clear();
      for (const editor of vscode.window.visibleTextEditors) {
        editor.setDecorations(heatDecoration, []);
        editor.setDecorations(heatLabelDecoration, []);
      }
      persist();
      updateContexts();
      sessionProvider.refresh();
      investigationProvider.refresh();
      findingsProvider.refresh();
      codeLensProvider.refresh();
    }),
    vscode.languages.registerCodeLensProvider({ language: 'go', scheme: 'file' }, codeLensProvider)
  );
  updateContexts();
  void vscode.commands.executeCommand('setContext', 'gotune.targetActive', false);
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.languageId === 'go') {
      applyProfileHeatToEditor(editor, heatDecoration, heatLabelDecoration);
    }
  }

  function addSession(session: ProfileSession, showResult = true): void {
    sessions.unshift(session);
    const sessionTarget = session.target ?? runner.snapshot.target?.importPath;
    const current = currentInvestigation();
    const investigation = current?.scenarioId
      && (!current.target || !sessionTarget || current.target === sessionTarget)
      ? current
      : ensureInvestigation(problemForSampleType(session.sampleType), sessionTarget);
    const updated = addCaptureToInvestigation(investigation, session);
    const investigationIndex = investigations.findIndex((item) => item.id === updated.id);
    investigations[investigationIndex] = updated;
    activeInvestigationId = updated.id;
    setActive(session);
    persist();
    investigationProvider.refresh();
    sessionProvider.refresh();
    findingsProvider.refresh();
    if (showResult) void vscode.commands.executeCommand('gotune.showProfile');
  }

  function currentInvestigation(): Investigation | undefined {
    return investigations.find((item) => item.id === activeInvestigationId);
  }

  function ensureInvestigation(problem: ProblemKind, target?: string): Investigation {
    const current = currentInvestigation();
    if (
      current
      && (problem === 'code' || current.problem === problem)
      && (!current.target || !target || current.target === target)
    ) {
      return current;
    }
    const investigation = createInvestigation(problem, target);
    investigations.unshift(investigation);
    activeInvestigationId = investigation.id;
    persist();
    investigationProvider.refresh();
    findingsProvider.refresh();
    return investigation;
  }

  function replaceInvestigation(investigation: Investigation): void {
    const index = investigations.findIndex((item) => item.id === investigation.id);
    if (index < 0) {
      investigations.unshift(investigation);
    } else {
      investigations[index] = investigation;
    }
    activeInvestigationId = investigation.id;
    persist();
    investigationProvider.refresh();
    findingsProvider.refresh();
  }

  function setActive(session: ProfileSession): void {
    activeSession = session;
    const owner = investigations.find((investigation) => investigation.captureIds.includes(session.id));
    if (owner) {
      activeInvestigationId = owner.id;
      investigationProvider.refresh();
    }
    persist();
    updateContexts();
    sessionProvider.refresh();
    findingsProvider.refresh();
    codeLensProvider.refresh();
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.languageId === 'go') {
        applyProfileHeatToEditor(editor, heatDecoration, heatLabelDecoration);
      }
    }
  }

  async function hotspotAtEditor(): Promise<Hotspot | undefined> {
    if (!activeSession) return undefined;
    const currentFunction = await functionAtEditor();
    if (!currentFunction) return undefined;
    const candidates = activeSession.hotspots.filter(
      (hotspot) => hotspot.location && sameSource(currentFunction.file, hotspot.location.file)
    );
    return candidates
      .filter((hotspot) => {
        const line = hotspot.location?.line ?? 1;
        return line >= currentFunction.startLine && line <= currentFunction.endLine;
      })
      .sort((left, right) => right.cumulative - left.cumulative)[0];
  }

  function updateContexts(): void {
    void vscode.commands.executeCommand('setContext', 'gotune.hasActiveProfile', Boolean(activeSession));
    void vscode.commands.executeCommand('setContext', 'gotune.hasBaseline', Boolean(baselineSessionId));
    void vscode.commands.executeCommand('setContext', 'gotune.activeProfileKind', profileKind(activeSession?.sampleType));
  }

  function persist(): void {
    const compactSessions = sessions.slice(0, 8).map(compactSession);
    void context.workspaceState.update(sessionsStorageKey, compactSessions);
    void context.workspaceState.update(activeSessionStorageKey, activeSession?.id);
    void context.workspaceState.update(baselineStorageKey, baselineSessionId);
    void context.workspaceState.update(investigationsStorageKey, investigations.slice(0, 20));
    void context.workspaceState.update(activeInvestigationStorageKey, activeInvestigationId);
    void context.workspaceState.update(scenariosStorageKey, scenarios);
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
      const durationMatch = /(?:^|[?&])seconds=(\d+)/.exec(profileUrl);
      session.target = runner.snapshot.target?.importPath;
      session.processStartedAt = runner.snapshot.startedAt;
      session.captureDurationMs = durationMatch ? Number(durationMatch[1]) * 1000 : undefined;
      session.captureMode = durationMatch ? 'delta' : 'snapshot';
      session.scenarioId = currentInvestigation()?.scenarioId;
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

  async function promptForScenario(): Promise<PerformanceScenario | undefined> {
    const name = await vscode.window.showInputBox({
      title: 'Create Performance Scenario',
      prompt: 'Name this repeatable workload',
      placeHolder: 'VPN 500-stream load test',
      validateInput: (value) => value.trim() ? undefined : 'Enter a scenario name'
    });
    if (!name) return undefined;
    const problem = await vscode.window.showQuickPick([
      { label: 'Operation is slow / CPU high', problem: 'cpu' as ProblemKind },
      { label: 'Memory keeps growing', problem: 'memory-growth' as ProblemKind },
      { label: 'Too many allocations / GC pressure', problem: 'allocations' as ProblemKind },
      { label: 'Request stuck / possible deadlock', problem: 'blocking' as ProblemKind },
      { label: 'Latency is high', problem: 'latency' as ProblemKind }
    ], { title: 'What should this scenario investigate?' });
    if (!problem) return undefined;
    const workloadKind = await vscode.window.showQuickPick([
      { label: 'Manual reproduction', workloadKind: 'manual' as const },
      { label: 'Run a VS Code Task', workloadKind: 'vscode-task' as const },
      { label: 'Run a shell command', workloadKind: 'command' as const }
    ], { title: 'How should GoTune reproduce the workload?' });
    if (!workloadKind) return undefined;
    let workload: string | undefined;
    if (workloadKind.workloadKind === 'vscode-task') {
      const tasks = await vscode.tasks.fetchTasks();
      const selected = await vscode.window.showQuickPick(
        tasks.map((task) => ({
          label: task.name,
          description: task.source,
          task
        })),
        { title: 'Select workload task' }
      );
      if (!selected) return undefined;
      workload = selected.task.name;
    } else if (workloadKind.workloadKind === 'command') {
      workload = await vscode.window.showInputBox({
        title: 'Workload Command',
        prompt: 'This command will run in a VS Code terminal when the scenario starts',
        placeHolder: 'go run ./cmd/loadgen -duration 30s',
        validateInput: (value) => value.trim() ? undefined : 'Enter a workload command'
      });
      if (!workload) return undefined;
    }
    const defaults = defaultScenarioCaptures(problem.problem);
    const captures = await vscode.window.showQuickPick([
      { label: 'CPU', evidenceKind: 'cpu' as EvidenceKind, picked: defaults.includes('cpu') },
      { label: 'Allocations', evidenceKind: 'allocation' as EvidenceKind, picked: defaults.includes('allocation') },
      { label: 'Live heap before/after', evidenceKind: 'live-memory' as EvidenceKind, picked: defaults.includes('live-memory') },
      { label: 'Repeated goroutine stacks', evidenceKind: 'goroutine' as EvidenceKind, picked: defaults.includes('goroutine') },
      { label: 'Mutex and block profiles', evidenceKind: 'blocking' as EvidenceKind, picked: defaults.includes('blocking') }
    ], {
      title: 'Evidence to collect',
      canPickMany: true
    });
    if (!captures || captures.length === 0) return undefined;
    const warmupText = await vscode.window.showInputBox({
      title: 'Warmup',
      prompt: 'Seconds to wait before starting the workload',
      value: '0',
      validateInput: positiveOrZeroNumber
    });
    if (warmupText === undefined) return undefined;
    const captureText = await vscode.window.showInputBox({
      title: 'Capture Duration',
      prompt: 'Seconds to collect timed evidence',
      value: String(vscode.workspace.getConfiguration('gotune').get<number>('captureCpuSeconds', 10)),
      validateInput: positiveNumber
    });
    if (!captureText) return undefined;
    const metricsText = await vscode.window.showInputBox({
      title: 'Success Metrics',
      prompt: 'Optional comma-separated outcomes such as throughput_mbps, p95_ms, errors',
      placeHolder: 'throughput_mbps, p95_ms, errors'
    });
    const now = Date.now();
    return {
      id: `${now}-${Math.random().toString(36).slice(2)}`,
      name: name.trim(),
      target: runner.snapshot.target?.importPath,
      problem: problem.problem,
      workloadKind: workloadKind.workloadKind,
      workload,
      warmupSeconds: Number(warmupText),
      captureSeconds: Number(captureText),
      captureKinds: captures.map((capture) => capture.evidenceKind),
      successMetrics: metricsText?.split(',').map((metric) => metric.trim()).filter(Boolean) ?? [],
      createdAt: now,
      updatedAt: now
    };
  }

  async function pickScenario(): Promise<PerformanceScenario | undefined> {
    const selected = await vscode.window.showQuickPick(
      scenarios.map((scenario) => ({
        label: scenario.name,
        description: `${scenario.problem} · ${scenario.captureSeconds}s`,
        scenario
      })),
      { title: 'Run Performance Scenario' }
    );
    return selected?.scenario;
  }

  async function runScenario(scenario: PerformanceScenario): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('GoTune: Trust this workspace before running a scenario.');
      return;
    }
    if (runner.snapshot.status !== 'running') {
      await vscode.commands.executeCommand('gotune.runWithProfiler');
      const statusAfterStart: string = runner.snapshot.status;
      if (statusAfterStart !== 'running') return;
    }
    const target = runner.snapshot.target?.importPath;
    if (scenario.target && target && scenario.target !== target) {
      void vscode.window.showErrorMessage(
        `GoTune: Scenario targets ${scenario.target}, but ${target} is running.`
      );
      return;
    }
    let investigation = investigations.find((item) => item.scenarioId === scenario.id);
    if (!investigation) {
      investigation = createInvestigation(scenario.problem, target);
      investigation.name = scenario.name;
      investigation.scenarioId = scenario.id;
      investigations.unshift(investigation);
    }
    activeInvestigationId = investigation.id;
    replaceInvestigation(investigation);
    const runStartedAt = Date.now();

    const completed = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `GoTune: running ${scenario.name}`,
        cancellable: false
      },
      async (progress) => {
        if (scenario.warmupSeconds > 0) {
          progress.report({ message: `warming up for ${scenario.warmupSeconds}s` });
          await delay(scenario.warmupSeconds * 1000);
        }
        const heapSnapshots: ProfileSession[] = [];
        if (scenario.captureKinds.includes('live-memory')) {
          progress.report({ message: 'capturing post-GC heap baseline' });
          const baseline = await captureManagedProfile(
            'heap?gc=1',
            `${scenario.name} heap baseline`,
            'inuse_space',
            undefined,
            false
          );
          if (baseline) heapSnapshots.push(baseline);
        }

        progress.report({ message: 'starting workload' });
        if (!await startScenarioWorkload(scenario)) return false;
        const timedCaptures: Promise<unknown>[] = [];
        if (scenario.captureKinds.includes('cpu')) {
          timedCaptures.push(captureManagedProfile(
            `profile?seconds=${scenario.captureSeconds}`,
            `${scenario.name} CPU`,
            undefined,
            scenario.captureSeconds * 1000 + 15_000,
            false
          ));
        }
        if (scenario.captureKinds.includes('allocation')) {
          timedCaptures.push(captureManagedProfile(
            `allocs?seconds=${scenario.captureSeconds}`,
            `${scenario.name} allocations`,
            'alloc_space',
            scenario.captureSeconds * 1000 + 15_000,
            false
          ));
        }
        if (scenario.captureKinds.includes('goroutine')) {
          timedCaptures.push(captureScenarioGoroutines(investigation!.id));
        }
        if (scenario.captureKinds.includes('blocking')) {
          timedCaptures.push(captureScenarioContention(scenario));
        }
        if (timedCaptures.length === 0) {
          await delay(scenario.captureSeconds * 1000);
        } else {
          await Promise.all(timedCaptures);
        }

        if (scenario.captureKinds.includes('live-memory')) {
          progress.report({ message: 'capturing post-workload live heap' });
          const after = await captureManagedProfile(
            'heap?gc=1',
            `${scenario.name} heap after`,
            'inuse_space',
            undefined,
            false
          );
          if (after) heapSnapshots.push(after);
          await delay(2000);
          const recovery = await captureManagedProfile(
            'heap?gc=1',
            `${scenario.name} heap recovery`,
            'inuse_space',
            undefined,
            false
          );
          if (recovery) heapSnapshots.push(recovery);
          if (heapSnapshots.length === 3) {
            const trend = analyzeMemoryTrend(heapSnapshots);
            const current = currentInvestigation();
            if (current) {
              replaceInvestigation(addFindingsToInvestigation(
                current,
                findingsFromMemoryTrend(current.id, trend),
                'memory-trend-'
              ));
            }
          }
        }
        return true;
      }
    );
    if (!completed) return;
    verifyScenarioCaptures(
      investigation.id,
      sessions.filter((session) =>
        session.scenarioId === scenario.id && session.importedAt >= runStartedAt
      )
    );
    investigationProvider.refresh();
    findingsProvider.refresh();
    void vscode.commands.executeCommand('gotune.findings.focus');
    void vscode.window.showInformationMessage(
      `GoTune: Scenario "${scenario.name}" finished. Review Findings and source evidence.`
    );
  }

  async function startScenarioWorkload(scenario: PerformanceScenario): Promise<boolean> {
    if (scenario.workloadKind === 'manual') {
      const action = await vscode.window.showInformationMessage(
        `GoTune: Reproduce "${scenario.name}" during the ${scenario.captureSeconds}s capture window.`,
        { modal: true },
        'Start Capture'
      );
      return action === 'Start Capture';
    }
    if (scenario.workloadKind === 'vscode-task') {
      const tasks = await vscode.tasks.fetchTasks();
      const task = tasks.find((candidate) => candidate.name === scenario.workload);
      if (!task) throw new Error(`VS Code task "${scenario.workload}" no longer exists`);
      await vscode.tasks.executeTask(task);
      return true;
    }
    if (!scenario.workload) throw new Error('Scenario workload command is missing');
    const task = new vscode.Task(
      { type: 'gotune-scenario', scenario: scenario.id },
      vscode.TaskScope.Workspace,
      `GoTune: ${scenario.name}`,
      'GoTune',
      new vscode.ShellExecution(scenario.workload)
    );
    await vscode.tasks.executeTask(task);
    return true;
  }

  async function captureScenarioGoroutines(investigationId: string): Promise<void> {
    goroutineTracker.reset();
    let snapshot = await captureGoroutineSnapshot();
    for (let index = 1; index < 3; index++) {
      await delay(2000);
      snapshot = await captureGoroutineSnapshot();
    }
    const investigation = investigations.find((item) => item.id === investigationId);
    if (!investigation) return;
    replaceInvestigation(addFindingsToInvestigation(
      investigation,
      findingsFromGoroutines(investigationId, snapshot),
      'goroutine-'
    ));
  }

  async function captureScenarioContention(scenario: PerformanceScenario): Promise<void> {
    if (!runner.snapshot.contentionProfilesEnabled) {
      void vscode.window.showWarningMessage(
        'GoTune: Mutex/Block evidence was skipped because contention profiling was not enabled for this run.'
      );
      return;
    }
    await Promise.all([
      captureManagedProfile(
        `mutex?seconds=${scenario.captureSeconds}`,
        `${scenario.name} mutex`,
        undefined,
        scenario.captureSeconds * 1000 + 15_000,
        false
      ),
      captureManagedProfile(
        `block?seconds=${scenario.captureSeconds}`,
        `${scenario.name} block`,
        undefined,
        scenario.captureSeconds * 1000 + 15_000,
        false
      )
    ]);
  }

  function verifyScenarioCaptures(investigationId: string, captures: ProfileSession[]): void {
    const investigation = investigations.find((item) => item.id === investigationId);
    if (!investigation) return;
    let updated: Investigation = {
      ...investigation,
      baselineByMetric: { ...investigation.baselineByMetric }
    };
    const verificationFindings: PerformanceFinding[] = [];
    for (const capture of captures.filter((session) => !/^inuse_/.test(session.sampleType))) {
      const key = sessionMetricKey(capture);
      const baselineId = updated.baselineByMetric[key];
      if (!baselineId) {
        updated.baselineByMetric[key] = capture.id;
        verificationFindings.push({
          id: `verification-${capture.id}-baseline`,
          investigationId,
          captureId: capture.id,
          kind: profileEvidenceKind(capture.sampleType),
          severity: 'info',
          title: `Baseline captured: ${profileKindLabel(capture.sampleType)}`,
          detail: `${capture.name} will be used when the same scenario runs again.`,
          createdAt: Date.now()
        });
        continue;
      }
      const baseline = sessions.find((session) => session.id === baselineId);
      if (!baseline || baseline.id === capture.id) continue;
      try {
        verificationFindings.push(...findingsFromComparison(
          investigationId,
          compareProfiles(baseline, capture)
        ));
      } catch (error) {
        verificationFindings.push({
          id: `verification-${capture.id}-warning`,
          investigationId,
          captureId: capture.id,
          kind: profileEvidenceKind(capture.sampleType),
          severity: 'watch',
          title: 'Verification conditions do not match',
          detail: errorMessage(error),
          createdAt: Date.now()
        });
      }
    }
    updated = addFindingsToInvestigation(
      updated,
      verificationFindings,
      'verification-'
    );
    replaceInvestigation(updated);
  }

  async function captureEvidenceForCurrentFunction(command: string): Promise<void> {
    if (runner.snapshot.status !== 'running') {
      const action = await vscode.window.showInformationMessage(
        'GoTune: Start the current Go target before capturing evidence.',
        'Run with GoTune'
      );
      if (action !== 'Run with GoTune') return;
      await vscode.commands.executeCommand('gotune.runWithProfiler');
      const statusAfterStart: string = runner.snapshot.status;
      if (statusAfterStart !== 'running') return;
    }
    await vscode.commands.executeCommand(command);
  }

  function showSessionProfile(session: ProfileSession, focusedHotspot?: Hotspot): void {
    const baseline = sessions.find((candidate) => candidate.id === baselineSessionId);
    const baselineState = baseline?.id === session.id
      ? 'current'
      : baseline?.sampleType === session.sampleType && baseline.sampleUnit === session.sampleUnit
        ? 'available'
        : 'none';
    showProfilePanel(
      session,
      (file, line) => void openSource(file, line, heatDecoration, heatLabelDecoration),
      focusedHotspot,
      (action, hotspot) => {
        if (action === 'escape') {
          void vscode.commands.executeCommand(
            'gotune.analyzeEscape',
            hotspot ? new HotspotItem(hotspot, session) : undefined
          );
        } else if (action === 'baseline') {
          void vscode.commands.executeCommand('gotune.setBaseline', new SessionItem(session));
        } else if (action === 'compare') {
          void vscode.commands.executeCommand('gotune.compareWithBaseline', new SessionItem(session));
        } else {
          const kind = profileKind(session.sampleType);
          const command = kind === 'allocation'
            ? 'gotune.captureAllocations'
            : kind === 'memory'
              ? 'gotune.checkMemoryGrowth'
              : kind === 'blocking'
                ? (/mutex/i.test(`${session.sampleType} ${session.name}`) ? 'gotune.captureMutex' : 'gotune.captureBlock')
                : 'gotune.captureCpu';
          void vscode.commands.executeCommand(command);
        }
      },
      baselineState
    );
  }

  function closeRuntimeOverview(): void {
    if (runtimeOverviewTimer) clearInterval(runtimeOverviewTimer);
    runtimeOverviewTimer = undefined;
    const panel = runtimeOverviewPanel;
    runtimeOverviewPanel = undefined;
    panel?.dispose();
  }
}

async function functionAtEditor(): Promise<GoFunctionReference | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'go' || editor.document.uri.scheme !== 'file') {
    return undefined;
  }
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider',
    editor.document.uri
  );
  const functions: vscode.DocumentSymbol[] = [];
  const visit = (items: vscode.DocumentSymbol[]): void => {
    for (const item of items) {
      if (item.kind === vscode.SymbolKind.Function || item.kind === vscode.SymbolKind.Method) {
        functions.push(item);
      }
      visit(item.children);
    }
  };
  visit(symbols ?? []);
  const symbol = functions
    .filter((candidate) => candidate.range.contains(editor.selection.active))
    .sort((left, right) => {
      const leftSize = left.range.end.line - left.range.start.line;
      const rightSize = right.range.end.line - right.range.start.line;
      return leftSize - rightSize;
    })[0];
  if (symbol) {
    return {
      name: symbol.name,
      file: editor.document.uri.fsPath,
      startLine: symbol.range.start.line + 1,
      endLine: symbol.range.end.line + 1
    };
  }

  for (let start = editor.selection.active.line; start >= 0; start--) {
    const startText = editor.document.lineAt(start).text;
    if (!/^\s*func\b/.test(startText)) continue;
    const signature = Array.from(
      { length: Math.min(8, editor.document.lineCount - start) },
      (_, offset) => editor.document.lineAt(start + offset).text
    ).join(' ');
    const match = /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?\(/.exec(signature);
    if (!match) continue;
    let depth = 0;
    let opened = false;
    for (let end = start; end < editor.document.lineCount; end++) {
      for (const character of editor.document.lineAt(end).text) {
        if (character === '{') {
          depth++;
          opened = true;
        } else if (character === '}') {
          depth--;
        }
      }
      if (opened && depth <= 0) {
        if (editor.selection.active.line > end) break;
        return {
          name: match[1],
          file: editor.document.uri.fsPath,
          startLine: start + 1,
          endLine: end + 1
        };
      }
    }
  }
  return undefined;
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
  applyProfileHeatToEditor(editor, heatDecoration, heatLabelDecoration);
}

function applyProfileHeatToEditor(
  editor: vscode.TextEditor,
  heatDecoration: vscode.TextEditorDecorationType,
  heatLabelDecoration: vscode.TextEditorDecorationType
): void {
  const document = editor.document;
  const uri = document.uri;
  const metrics = activeSession?.lineMetrics.filter((metric) => sameSource(uri.fsPath, metric.file)) ?? [];
  const max = Math.max(...metrics.map((metric) => metric.value), 1);
  const lineDecorations = metrics.map((metric) => {
    const metricLine = Math.max(0, Math.min(document.lineCount - 1, metric.line - 1));
    const percent = activeSession?.total ? metric.value / activeSession.total * 100 : 0;
    return {
      range: document.lineAt(metricLine).range,
      hoverMessage: [
        `$(flame) **${metric.functionName}**`,
        '',
        `Self: ${metric.flat === undefined ? 'not recorded in this saved session' : formatValue(metric.flat, activeSession?.sampleUnit ?? '')}`,
        `With callees: ${formatValue(metric.value, activeSession?.sampleUnit ?? '')} (${percent.toFixed(1)}% of profile)`,
        '',
        '_With callees includes samples spent in functions called from this line._'
      ].join('\n\n')
    };
  });
  const labels = metrics.map((metric) => {
    const metricLine = Math.max(0, Math.min(document.lineCount - 1, metric.line - 1));
    const percent = activeSession?.total ? metric.value / activeSession.total * 100 : 0;
    const lineRange = document.lineAt(metricLine).range;
    return {
      range: new vscode.Range(lineRange.end, lineRange.end),
      renderOptions: {
        after: {
          contentText: ` GoTune ${percent.toFixed(1)}% with callees`,
          opacity: String(0.45 + 0.55 * metric.value / max)
        }
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

function profileKind(sampleType?: string): 'cpu' | 'allocation' | 'memory' | 'blocking' | 'other' {
  if (sampleType === 'cpu') return 'cpu';
  if (sampleType && /^alloc_/.test(sampleType)) return 'allocation';
  if (sampleType && /^inuse_/.test(sampleType)) return 'memory';
  if (sampleType && /delay|contentions|mutex|block/i.test(sampleType)) return 'blocking';
  return 'other';
}

function profileKindLabel(sampleType: string): string {
  const kind = profileKind(sampleType);
  if (kind === 'cpu') return 'CPU';
  if (kind === 'memory') return 'Heap';
  if (kind === 'blocking') return 'Wait';
  return 'Profile';
}

function sessionMetricKey(session: ProfileSession): string {
  const source = session.source.toLowerCase();
  const sourceKind = source.includes('/mutex') ? 'mutex'
    : source.includes('/block') ? 'block'
      : source.includes('/profile') ? 'cpu'
        : source.includes('/allocs') ? 'allocations'
          : source.includes('/heap') ? 'heap' : 'profile';
  return `${session.sampleType}:${session.sampleUnit}:${sourceKind}`;
}

function defaultScenarioCaptures(problem: ProblemKind): EvidenceKind[] {
  if (problem === 'memory-growth') return ['live-memory', 'allocation', 'goroutine'];
  if (problem === 'allocations') return ['allocation', 'cpu'];
  if (problem === 'blocking') return ['goroutine', 'blocking'];
  if (problem === 'latency') return ['cpu', 'goroutine', 'blocking'];
  return ['cpu', 'allocation'];
}

function positiveOrZeroNumber(value: string): string | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? undefined : 'Enter a number greater than or equal to 0';
}

function positiveNumber(value: string): string | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? undefined : 'Enter a number greater than 0';
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

function isInvestigation(value: unknown): value is Investigation {
  if (!value || typeof value !== 'object') return false;
  const investigation = value as Partial<Investigation>;
  return typeof investigation.id === 'string'
    && typeof investigation.name === 'string'
    && typeof investigation.problem === 'string'
    && Array.isArray(investigation.captureIds)
    && Array.isArray(investigation.findings)
    && Boolean(investigation.baselineByMetric)
    && typeof investigation.createdAt === 'number'
    && typeof investigation.updatedAt === 'number';
}

function isPerformanceScenario(value: unknown): value is PerformanceScenario {
  if (!value || typeof value !== 'object') return false;
  const scenario = value as Partial<PerformanceScenario>;
  return typeof scenario.id === 'string'
    && typeof scenario.name === 'string'
    && typeof scenario.problem === 'string'
    && typeof scenario.workloadKind === 'string'
    && typeof scenario.warmupSeconds === 'number'
    && typeof scenario.captureSeconds === 'number'
    && Array.isArray(scenario.captureKinds)
    && Array.isArray(scenario.successMetrics)
    && typeof scenario.createdAt === 'number'
    && typeof scenario.updatedAt === 'number';
}

export function deactivate(): void {}
