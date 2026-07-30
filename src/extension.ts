import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runGoBenchmark } from './benchmark';
import { BenchmarkSnapshot, showBenchmarkPanel } from './benchmarkView';
import { compareProfiles } from './compare';
import { analyzeEscapes, resolveSourceFile } from './escape';
import {
  collectFunctionEvidence,
  findFunctionHotspot,
  FunctionEvidenceItem
} from './functionEvidence';
import { showFunctionEvidencePanel } from './functionEvidenceView';
import { isMainGoSource } from './goSource';
import { readGitState } from './gitState';
import { GoroutineTracker } from './goroutine';
import { launchTargetIdentity } from './launch';
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
  RuntimeMetrics,
  ScenarioRunRecord
} from './model';
import { listProfileSampleTypes, parseProfile } from './profileParser';
import { buildProfileUrl } from './profileUrl';
import { discoverMainPackages, MainPackage, ProfilerRunner, resolveMainPackage } from './runner';
import { inspectStructLayout } from './structLayout';
import { showStructLayoutPanel } from './structLayoutView';
import {
  collectScenarioMetrics,
  MetricsAdapter,
  parseMetricPatternSpec
} from './scenarioMetrics';
import { showScenarioResultPanel } from './scenarioResultView';
import { sourcePathsMatch } from './sourcePath';
import { TraceViewer } from './traceViewer';
import { deriveTraceProfiles, TraceProfileKind } from './traceProfiles';
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

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const functions = await goFunctionsInDocument(document);
    return functions.flatMap((fn) => {
      const report = collectFunctionEvidence(
        fn,
        sessions,
        activeBaselineSessionIds(),
        configuredSourcePathMappings()
      );
      if (report.items.length === 0) return [];
      return [new vscode.CodeLens(document.lineAt(fn.startLine - 1).range, {
        command: 'gotune.inspectCurrentFunction',
        title: functionEvidenceSummary(report.items),
        arguments: [fn]
      })];
    });
  }
}

class FunctionEvidenceHoverProvider implements vscode.HoverProvider {
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const fn = await functionAtDocumentPosition(document, position);
    if (!fn) return undefined;
    const report = collectFunctionEvidence(
      fn,
      sessions,
      activeBaselineSessionIds(),
      configuredSourcePathMappings()
    );
    if (report.items.length === 0) return undefined;
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = { enabledCommands: ['gotune.inspectCurrentFunction'] };
    markdown.appendMarkdown(`### GoTune · \`${fn.name}\`\n\n`);
    for (const item of latestFunctionEvidence(report.items)) {
      markdown.appendMarkdown(
        `- **${functionEvidenceKindLabel(item.kind)}**: `
        + `${formatValue(item.self, item.sampleUnit)} self (${item.selfPercent.toFixed(1)}%), `
        + `${formatValue(item.cumulative, item.sampleUnit)} with callees (${item.cumulativePercent.toFixed(1)}%)`
        + functionEvidenceDeltaText(item.baselineDeltaPercent)
        + '\n'
      );
    }
    markdown.appendMarkdown(
      `\n[Open combined evidence](command:gotune.inspectCurrentFunction?${encodeURIComponent(JSON.stringify([fn]))})`
    );
    markdown.appendMarkdown(
      '\n\n_Self is spent in this function. With callees includes work below it in the sampled call path._'
    );
    return new vscode.Hover(markdown);
  }
}

class FunctionEvidenceCodeActionProvider implements vscode.CodeActionProvider {
  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range
  ): Promise<vscode.CodeAction[]> {
    const fn = await functionAtDocumentPosition(document, range.start);
    if (!fn) {
      const struct = await structAtDocumentPosition(document, range.start);
      if (!struct) return [];
      const layout = new vscode.CodeAction('GoTune: Inspect struct memory layout', vscode.CodeActionKind.QuickFix);
      layout.command = {
        command: 'gotune.inspectStructLayout',
        title: layout.title,
        arguments: [struct]
      };
      return [layout];
    }
    const report = collectFunctionEvidence(
      fn,
      sessions,
      activeBaselineSessionIds(),
      configuredSourcePathMappings()
    );
    const actions: vscode.CodeAction[] = [];
    const inspect = new vscode.CodeAction('GoTune: Inspect combined function evidence', vscode.CodeActionKind.QuickFix);
    inspect.command = {
      command: 'gotune.inspectCurrentFunction',
      title: inspect.title,
      arguments: [fn]
    };
    actions.push(inspect);
    for (const kind of (['cpu', 'allocation', 'live-memory'] as EvidenceKind[])) {
      if (report.availableKinds.includes(kind)) continue;
      const capture = new vscode.CodeAction(
        `GoTune: Capture missing ${functionEvidenceKindLabel(kind)} evidence`,
        vscode.CodeActionKind.QuickFix
      );
      capture.command = {
        command: 'gotune.captureFunctionEvidence',
        title: capture.title,
        arguments: [kind]
      };
      actions.push(capture);
    }
    if (report.availableKinds.includes('allocation')) {
      const escapes = new vscode.CodeAction('GoTune: Analyze escapes in this function', vscode.CodeActionKind.QuickFix);
      escapes.command = {
        command: 'gotune.analyzeEscape',
        title: escapes.title
      };
      actions.push(escapes);
    }
    return actions;
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
  const findingDiagnostics = vscode.languages.createDiagnosticCollection('gotune-findings');
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
    gutterIconPath: context.asAbsolutePath('resources/evidence.svg'),
    gutterIconSize: 'contain',
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
    findingDiagnostics,
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
      if (event.affectsConfiguration('gotune.sourcePathMappings')) {
        codeLensProvider.refresh();
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document.languageId === 'go') {
            applyProfileHeatToEditor(editor, heatDecoration, heatLabelDecoration);
          }
        }
        void refreshFindingDiagnostics();
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
      async (request?: { skipCurrentEditor?: boolean; enableContentionProfiles?: boolean }) => {
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
            enableContentionProfiles: request?.enableContentionProfiles
              ?? configuration.get<boolean>('enableContentionProfiles', false)
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
    vscode.commands.registerCommand('gotune.startInvestigation', async () => {
      try {
        await runGuidedInvestigation();
      } catch (error) {
        targetOutput.appendLine(`[GoTune] Guided investigation failed: ${errorMessage(error)}`);
        void vscode.window.showErrorMessage(`GoTune: ${errorMessage(error)}`);
      }
    }),
    vscode.commands.registerCommand('gotune.runLaunchWithProfiler', async () => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage('GoTune: Trust this workspace before running a launch configuration.');
        return;
      }
      try {
        await startLaunchWithProfiler();
      } catch (error) {
        await runner.stop();
        targetOutput.show(true);
        void vscode.window.showErrorMessage(`GoTune: ${errorMessage(error)}`);
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
        const derived = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'GoTune: mapping trace waits back to source',
            cancellable: false
          },
          () => deriveTraceProfiles(bytes, execution.goExecutable, execution.environment)
        );
        for (const profile of derived) {
          const session = parseProfile(
            profile.bytes,
            `Trace ${traceProfileLabel(profile.kind)} ${new Date().toLocaleTimeString()}`,
            `trace:${profile.kind}`,
            'delay'
          );
          session.target = activeTargetIdentity();
          session.processStartedAt = runner.snapshot.startedAt;
          session.captureDurationMs = seconds * 1000;
          session.captureMode = 'delta';
          session.scenarioId = currentInvestigation()?.scenarioId;
          addSession(session, false);
        }
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
      const investigation = ensureInvestigation('blocking', activeTargetIdentity());
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
    vscode.commands.registerCommand('gotune.inspectCurrentFunction', async (requested?: GoFunctionReference) => {
      const fn = requested ?? await functionAtEditor();
      if (!fn) {
        void vscode.window.showInformationMessage('GoTune: Put the cursor inside a Go function first.');
        return;
      }
      ensureInvestigation('code', activeTargetIdentity());
      const report = collectFunctionEvidence(
        fn,
        sessions,
        activeBaselineSessionIds(),
        configuredSourcePathMappings()
      );
      showFunctionEvidencePanel(report, (action) => {
        if (action.command === 'open-source') {
          void openSource(fn.file, fn.startLine, heatDecoration, heatLabelDecoration);
          return;
        }
        if (action.command === 'open-related-source') {
          void openSource(
            action.file,
            action.line,
            heatDecoration,
            heatLabelDecoration
          );
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
        const hotspot = findFunctionHotspot(fn, session, configuredSourcePathMappings());
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
    vscode.commands.registerCommand('gotune.captureFunctionEvidence', async (kind: EvidenceKind) => {
      const command = kind === 'cpu'
        ? 'gotune.captureCpu'
        : kind === 'allocation' ? 'gotune.captureAllocations' : 'gotune.captureHeap';
      await captureEvidenceForCurrentFunction(command);
    }),
    vscode.commands.registerCommand(
      'gotune.inspectStructLayout',
      async (requested?: { name: string; file: string; startLine: number; endLine: number }) => {
        const struct = requested ?? await structAtEditor();
        if (!struct) {
          void vscode.window.showInformationMessage('GoTune: Put the cursor inside a Go struct type first.');
          return;
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(struct.file));
        if (document.isDirty && !await document.save()) {
          throw new Error('Save the Go source before inspecting its struct layout');
        }
        const inspectedVersion = document.version;
        const execution = resolveGoExecutionConfiguration();
        try {
          const result = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `GoTune: inspecting ${struct.name} layout`,
              cancellable: false
            },
            () => inspectStructLayout({
              goExecutable: execution.goExecutable,
              helperPath: context.asAbsolutePath('helper/cmd/gotune-helper/main.go'),
              file: struct.file,
              name: struct.name,
              environment: execution.environment
            })
          );
          showStructLayoutPanel(result, () => {
            void applySafeStructLayout(document.uri, inspectedVersion, result.optimizedSource);
          });
        } catch (error) {
          targetOutput.appendLine(`[GoTune] Struct layout failed: ${errorMessage(error)}`);
          void vscode.window.showErrorMessage(`GoTune: ${errorMessage(error)}`);
        }
      }
    ),
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
    vscode.commands.registerCommand(
      'gotune.openFindingEvidence',
      (input?: InvestigationFindingItem | PerformanceFinding) => {
        const finding = findingFromInput(input);
        if (!finding) return;
        const session = sessions.find((candidate) => candidate.id === finding.captureId);
        if (!session) {
          void vscode.window.showInformationMessage(
            'GoTune: This finding is based on combined trend evidence rather than one raw profile.'
          );
          return;
        }
        setActive(session);
        const hotspot = finding.location
          ? session.hotspots.find((candidate) =>
            candidate.location
            && sameSource(candidate.location.file, finding.location!.file)
            && candidate.location.line === finding.location!.line
          )
          : undefined;
        showSessionProfile(session, hotspot);
      }
    ),
    vscode.commands.registerCommand(
      'gotune.nextFindingAction',
      async (input?: InvestigationFindingItem | PerformanceFinding) => {
        const finding = findingFromInput(input);
        if (!finding) return;
        const actions: Array<{
          label: string;
          description: string;
          action: string;
        }> = [];
        if (finding.location) {
          actions.push({
            label: 'Open source location',
            description: `${finding.location.file}:${finding.location.line}`,
            action: 'source'
          });
        }
        if (finding.captureId) {
          actions.push({
            label: 'Open full runtime evidence',
            description: 'Top, flame graph, call tree, and source',
            action: 'evidence'
          });
        }
        if (finding.kind === 'allocation') {
          actions.push({
            label: 'Analyze escape decisions',
            description: 'Explain why values move to the heap',
            action: 'escape'
          });
        }
        if (finding.kind === 'live-memory') {
          actions.push({
            label: 'Repeat memory-growth investigation',
            description: 'Three post-GC snapshots plus allocations and goroutines',
            action: 'memory'
          });
        }
        if (finding.kind === 'blocking' || finding.kind === 'goroutine') {
          actions.push(
            {
              label: 'Inspect goroutine progress',
              description: 'Repeated stacks distinguish stable blocking from normal waits',
              action: 'goroutines'
            },
            {
              label: 'Capture execution trace',
              description: 'Inspect scheduler, syscalls, and wall-clock waiting',
              action: 'trace'
            }
          );
        }
        if (finding.kind === 'cpu') {
          actions.push({
            label: 'Capture CPU again',
            description: 'Reproduce the operation in a new timed window',
            action: 'cpu'
          });
        }
        const investigation = currentInvestigation();
        if (investigation?.scenarioId) {
          actions.push({
            label: 'Verify with the same scenario',
            description: 'Reuse target, workload, warmup, capture protocol, and metrics',
            action: 'verify'
          });
        }
        actions.push({
          label: 'Mark as optimization target',
          description: 'Keep this source-backed conclusion as the current fix target',
          action: 'target'
        });
        const selected = await vscode.window.showQuickPick(actions, {
          title: finding.title,
          placeHolder: 'Choose the next action supported by this evidence'
        });
        if (!selected) return;
        if (selected.action === 'source') {
          await vscode.commands.executeCommand('gotune.showFindingSource', finding);
        } else if (selected.action === 'evidence') {
          await vscode.commands.executeCommand('gotune.openFindingEvidence', finding);
        } else if (selected.action === 'escape') {
          const session = sessions.find((candidate) => candidate.id === finding.captureId);
          const hotspot = session?.hotspots.find((candidate) =>
            finding.location
            && candidate.location
            && sameSource(candidate.location.file, finding.location.file)
            && candidate.location.line === finding.location.line
          );
          await vscode.commands.executeCommand(
            'gotune.analyzeEscape',
            hotspot && session ? new HotspotItem(hotspot, session) : undefined
          );
        } else if (selected.action === 'memory') {
          await vscode.commands.executeCommand('gotune.startInvestigation');
        } else if (selected.action === 'goroutines') {
          await vscode.commands.executeCommand('gotune.monitorGoroutines');
        } else if (selected.action === 'trace') {
          await vscode.commands.executeCommand('gotune.captureTrace');
        } else if (selected.action === 'cpu') {
          await vscode.commands.executeCommand('gotune.captureCpu');
        } else if (selected.action === 'verify') {
          const scenario = scenarios.find((candidate) => candidate.id === investigation?.scenarioId);
          if (scenario) await runScenario(scenario);
        } else if (selected.action === 'target' && investigation) {
          investigation.targetFindingId = finding.id;
          investigation.updatedAt = Date.now();
          persist();
          investigationProvider.refresh();
          void vscode.window.showInformationMessage(`GoTune: "${finding.title}" is now the optimization target.`);
        }
      }
    ),
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
      codeLensProvider.refresh();
      void refreshFindingDiagnostics();
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
      findingDiagnostics.clear();
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
    vscode.languages.registerCodeLensProvider({ language: 'go', scheme: 'file' }, codeLensProvider),
    vscode.languages.registerHoverProvider(
      { language: 'go', scheme: 'file' },
      new FunctionEvidenceHoverProvider()
    ),
    vscode.languages.registerCodeActionsProvider(
      { language: 'go', scheme: 'file' },
      new FunctionEvidenceCodeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    )
  );
  updateContexts();
  void vscode.commands.executeCommand('setContext', 'gotune.targetActive', false);
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.languageId === 'go') {
      applyProfileHeatToEditor(editor, heatDecoration, heatLabelDecoration);
    }
  }
  void refreshFindingDiagnostics();

  function addSession(session: ProfileSession, showResult = true): void {
    sessions.unshift(session);
    const sessionTarget = session.target ?? activeTargetIdentity();
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
    codeLensProvider.refresh();
    void refreshFindingDiagnostics();
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.languageId === 'go') {
        applyProfileHeatToEditor(editor, heatDecoration, heatLabelDecoration);
      }
    }
  }

  function setActive(session: ProfileSession): void {
    activeSession = session;
    const owner = investigations.find((investigation) => investigation.captureIds.includes(session.id));
    if (owner) {
      activeInvestigationId = owner.id;
      investigationProvider.refresh();
      void refreshFindingDiagnostics();
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
    const requiredSessionIds = new Set<string>([
      ...(baselineSessionId ? [baselineSessionId] : []),
      ...investigations.flatMap((investigation) => [
        ...investigation.captureIds.slice(0, 3),
        ...Object.values(investigation.baselineByMetric)
      ])
    ]);
    const sessionsToPersist = sessions.filter(
      (session, index) => index < 12 || requiredSessionIds.has(session.id)
    ).slice(0, 40);
    const compactSessions = sessionsToPersist.map(compactSession);
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
      session.target = activeTargetIdentity();
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

  async function runGuidedInvestigation(): Promise<void> {
    const selected = await vscode.window.showQuickPick([
      {
        label: 'CPU high or operation is slow',
        description: 'CPU profile with source self/cumulative evidence',
        problem: 'cpu' as ProblemKind
      },
      {
        label: 'Memory keeps growing',
        description: 'post-GC heap trend, allocation delta, and goroutine growth',
        problem: 'memory-growth' as ProblemKind
      },
      {
        label: 'Too many allocations or GC pressure',
        description: 'timed allocation delta with escape-analysis actions',
        problem: 'allocations' as ProblemKind
      },
      {
        label: 'Request stuck or possible deadlock',
        description: 'repeated goroutine stacks plus block and mutex evidence',
        problem: 'blocking' as ProblemKind
      },
      {
        label: 'Latency is high but CPU is unclear',
        description: 'CPU, goroutines, contention, and optional execution trace',
        problem: 'latency' as ProblemKind
      }
    ], {
      title: 'Investigate a Performance Problem',
      placeHolder: 'Describe the symptom; GoTune will choose the evidence'
    });
    if (!selected) return;
    if (runner.snapshot.status !== 'running') {
      await vscode.commands.executeCommand('gotune.runWithProfiler', {
        enableContentionProfiles: selected.problem === 'blocking' || selected.problem === 'latency'
      });
      const statusAfterStart: string = runner.snapshot.status;
      if (statusAfterStart !== 'running') return;
    }
    const investigation = createInvestigation(selected.problem, activeTargetIdentity());
    investigations.unshift(investigation);
    activeInvestigationId = investigation.id;
    persist();
    investigationProvider.refresh();
    findingsProvider.refresh();

    const seconds = vscode.workspace.getConfiguration('gotune').get<number>('captureCpuSeconds', 10);
    if (selected.problem === 'memory-growth') {
      await runMemoryGrowthInvestigation(investigation, seconds);
    } else {
      const action = await vscode.window.showInformationMessage(
        `GoTune: Reproduce the problem during the next ${seconds} seconds. GoTune will choose and combine the evidence.`,
        { modal: true },
        'Start Investigation'
      );
      if (action !== 'Start Investigation') return;
      if (selected.problem === 'cpu') {
        await captureManagedProfile(
          `profile?seconds=${seconds}`,
          'Operation CPU evidence',
          undefined,
          seconds * 1000 + 15_000,
          false
        );
      } else if (selected.problem === 'allocations') {
        await captureManagedProfile(
          `allocs?seconds=${seconds}`,
          'Allocation delta',
          'alloc_space',
          seconds * 1000 + 15_000,
          false
        );
      } else {
        const captures: Promise<unknown>[] = [
          captureScenarioGoroutines(investigation.id)
        ];
        if (selected.problem === 'latency') {
          captures.push(captureManagedProfile(
            `profile?seconds=${seconds}`,
            'Latency CPU evidence',
            undefined,
            seconds * 1000 + 15_000,
            false
          ));
        } else {
          captures.push(delay(seconds * 1000));
        }
        if (runner.snapshot.contentionProfilesEnabled) {
          captures.push(captureScenarioContention({
            id: investigation.id,
            name: investigation.name,
            target: investigation.target,
            problem: investigation.problem,
            workloadKind: 'manual',
            warmupSeconds: 0,
            captureSeconds: seconds,
            captureKinds: ['blocking'],
            successMetrics: [],
            createdAt: investigation.createdAt,
            updatedAt: investigation.updatedAt
          }));
        } else {
          void vscode.window.showInformationMessage(
            'GoTune: The current process was started without contention sampling. Goroutine progress is still checked; restart with contention profiling for Mutex/Block evidence.'
          );
        }
        await Promise.all(captures);
        if (selected.problem === 'latency') {
          const trace = await vscode.window.showInformationMessage(
            'GoTune: CPU and waiting evidence is ready. Capture a short execution trace for scheduler and wall-clock timing?',
            'Capture Trace',
            'Not now'
          );
          if (trace === 'Capture Trace') {
            await vscode.commands.executeCommand('gotune.captureTrace');
          }
        }
      }
    }
    investigationProvider.refresh();
    findingsProvider.refresh();
    codeLensProvider.refresh();
    void vscode.commands.executeCommand('gotune.findings.focus');
  }

  async function runMemoryGrowthInvestigation(
    investigation: Investigation,
    seconds: number
  ): Promise<void> {
    const heaps: ProfileSession[] = [];
    const baseline = await captureManagedProfile(
      'heap?gc=1',
      'Memory growth baseline',
      'inuse_space',
      undefined,
      false
    );
    if (baseline) heaps.push(baseline);
    const start = await vscode.window.showInformationMessage(
      `GoTune: Run the suspected leaking operation during the next ${seconds} seconds.`,
      { modal: true },
      'Start round 1'
    );
    if (start !== 'Start round 1') return;
    await Promise.all([
      captureManagedProfile(
        `allocs?seconds=${seconds}`,
        'Allocation delta during memory investigation',
        'alloc_space',
        seconds * 1000 + 15_000,
        false
      ),
      captureScenarioGoroutines(investigation.id),
      delay(seconds * 1000)
    ]);
    const after = await captureManagedProfile(
      'heap?gc=1',
      'Memory growth round 1',
      'inuse_space',
      undefined,
      false
    );
    if (after) heaps.push(after);
    const repeat = await vscode.window.showInformationMessage(
      `GoTune: Repeat the same operation once more during the next ${seconds} seconds.`,
      { modal: true },
      'Start round 2'
    );
    if (repeat !== 'Start round 2') return;
    await delay(seconds * 1000);
    const recovery = await captureManagedProfile(
      'heap?gc=1',
      'Memory growth round 2',
      'inuse_space',
      undefined,
      false
    );
    if (recovery) heaps.push(recovery);
    if (heaps.length !== 3) return;
    const trend = analyzeMemoryTrend(heaps);
    const latest = investigations.find((candidate) => candidate.id === investigation.id);
    if (latest) {
      replaceInvestigation(addFindingsToInvestigation(
        latest,
        findingsFromMemoryTrend(latest.id, trend),
        'memory-trend-'
      ));
    }
    showMemoryTrendPanel(
      trend,
      (file, line) => void openSource(file, line, heatDecoration, heatLabelDecoration)
    );
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
      { label: 'Run a shell command', workloadKind: 'command' as const },
      { label: 'Run Go Benchmark', workloadKind: 'benchmark' as const }
    ], { title: 'How should GoTune reproduce the workload?' });
    if (!workloadKind) return undefined;
    const targetChoice = workloadKind.workloadKind === 'benchmark'
      ? await pickBenchmarkTarget()
      : await pickScenarioTarget();
    if (!targetChoice) return undefined;
    let workload: string | undefined;
    let benchmarkCount: number | undefined;
    let benchmarkTime: string | undefined;
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
    } else if (workloadKind.workloadKind === 'benchmark') {
      workload = await vscode.window.showInputBox({
        title: 'Benchmark Pattern',
        prompt: 'Go benchmark regular expression passed to -bench',
        value: '.',
        validateInput: (value) => value.trim() ? undefined : 'Enter a benchmark pattern'
      });
      if (!workload) return undefined;
      const countText = await vscode.window.showInputBox({
        title: 'Benchmark Repetitions',
        prompt: 'Repeated samples make before/after comparisons less noisy',
        value: '5',
        validateInput: (value) =>
          Number.isInteger(Number(value)) && Number(value) > 0
            ? undefined
            : 'Enter a positive whole number'
      });
      if (!countText) return undefined;
      benchmarkCount = Number(countText);
      benchmarkTime = await vscode.window.showInputBox({
        title: 'Benchmark Time',
        prompt: 'Value passed to go test -benchtime',
        value: '1s',
        validateInput: (value) => /^\d+(?:\.\d+)?(?:ns|us|ms|s|x)$/.test(value)
          ? undefined
          : 'Use a Go duration such as 500ms, 1s, or an iteration count such as 100x'
      });
      if (!benchmarkTime) return undefined;
    }
    const defaults = defaultScenarioCaptures(problem.problem);
    const captures = workloadKind.workloadKind === 'benchmark'
      ? [
        { label: 'CPU', evidenceKind: 'cpu' as EvidenceKind },
        { label: 'Allocations', evidenceKind: 'allocation' as EvidenceKind }
      ]
      : await vscode.window.showQuickPick([
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
    let warmupText = '0';
    let captureText = '0';
    let successMetrics = ['ns/op', 'B/op', 'allocs/op'];
    let metricsAdapter: MetricsAdapter | undefined;
    if (workloadKind.workloadKind !== 'benchmark') {
      const selectedWarmup = await vscode.window.showInputBox({
        title: 'Warmup',
        prompt: 'Seconds to wait before starting the workload',
        value: '0',
        validateInput: positiveOrZeroNumber
      });
      if (selectedWarmup === undefined) return undefined;
      warmupText = selectedWarmup;
      const selectedCapture = await vscode.window.showInputBox({
        title: 'Capture Duration',
        prompt: 'Seconds to collect timed evidence',
        value: String(vscode.workspace.getConfiguration('gotune').get<number>('captureCpuSeconds', 10)),
        validateInput: positiveNumber
      });
      if (!selectedCapture) return undefined;
      captureText = selectedCapture;
      const metricsText = await vscode.window.showInputBox({
        title: 'Success Metrics',
        prompt: 'Optional comma-separated outcomes such as throughput_mbps, p95_ms, errors',
        placeHolder: 'throughput_mbps, p95_ms, errors'
      });
      successMetrics = metricsText?.split(',').map((metric) => metric.trim()).filter(Boolean) ?? [];
      if (successMetrics.length > 0) {
        const adapter = await vscode.window.showQuickPick([
          { label: 'Command prints JSON Lines', adapterKind: 'json-command' as const },
          { label: 'Command output matched by regular expressions', adapterKind: 'regex-command' as const },
          { label: 'Prometheus HTTP API queries', adapterKind: 'prometheus' as const },
          { label: 'Record names only (no automatic values)', adapterKind: undefined }
        ], {
          title: 'Business Metrics Source',
          placeHolder: 'Optional: collect throughput, latency, or error counts after the workload'
        });
        if (!adapter) return undefined;
        if (adapter.adapterKind) {
          if (adapter.adapterKind === 'prometheus') {
            const urls: Record<string, string> = {};
            for (const metric of successMetrics) {
              const url = await vscode.window.showInputBox({
                title: `Prometheus Query: ${metric}`,
                prompt: 'Direct /api/v1/query or /api/v1/query_range URL returning exactly one series',
                placeHolder: `http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent(metric)}`,
                validateInput: (value) => {
                  try {
                    const parsed = new URL(value);
                    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
                      ? undefined
                      : 'Use an http or https URL';
                  } catch {
                    return 'Enter a valid Prometheus HTTP API URL';
                  }
                }
              });
              if (!url) return undefined;
              urls[metric] = url;
            }
            metricsAdapter = { kind: 'prometheus', urls };
          } else {
            const command = await vscode.window.showInputBox({
              title: 'Metrics Command',
              prompt: 'Run after capture; use a script, load-generator summary command, or curl',
              placeHolder: './loadgen --summary-json'
            });
            if (!command) return undefined;
            let patterns: Record<string, string> | undefined;
            if (adapter.adapterKind === 'regex-command') {
              const patternSpec = await vscode.window.showInputBox({
                title: 'Metric Regular Expressions',
                prompt: 'Semicolon-separated name=regex entries; capture group 1 must be numeric',
                placeHolder: 'throughput=Throughput: ([\\d.]+);p95=p95: ([\\d.]+)'
              });
              if (!patternSpec) return undefined;
              patterns = parseMetricPatternSpec(patternSpec);
              if (Object.keys(patterns).length === 0) {
                void vscode.window.showWarningMessage('GoTune: No valid metric patterns were entered.');
                return undefined;
              }
            }
            metricsAdapter = { kind: adapter.adapterKind, command, patterns };
          }
        }
      }
    }
    const now = Date.now();
    return {
      id: `${now}-${Math.random().toString(36).slice(2)}`,
      name: name.trim(),
      target: targetChoice.identity,
      targetDirectory: targetChoice.target.directory,
      launchConfiguration: targetChoice.launch?.configuration.name,
      launchWorkspaceFolder: targetChoice.launch?.folder.uri.fsPath,
      problem: problem.problem,
      workloadKind: workloadKind.workloadKind,
      workload,
      warmupSeconds: Number(warmupText),
      captureSeconds: Number(captureText),
      captureKinds: captures.map((capture) => capture.evidenceKind),
      successMetrics,
      metricsAdapter,
      benchmarkCount,
      benchmarkTime,
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
    if (scenario.workloadKind === 'benchmark') {
      await runBenchmarkScenario(scenario);
      return;
    }
    if (runner.snapshot.status !== 'running') {
      if (scenario.launchConfiguration) {
        const launch = goLaunchConfigurations().find((candidate) =>
          candidate.configuration.name === scenario.launchConfiguration
          && candidate.folder.uri.fsPath === scenario.launchWorkspaceFolder
        );
        if (!launch) {
          throw new Error(
            `Launch configuration "${scenario.launchConfiguration}" no longer exists in ${scenario.launchWorkspaceFolder}`
          );
        }
        await startLaunchWithProfiler(launch);
      } else if (scenario.targetDirectory && scenario.target) {
        const execution = resolveGoExecutionConfiguration();
        const configuration = vscode.workspace.getConfiguration('gotune');
        await runner.start({
          target: {
            importPath: scenario.target,
            directory: scenario.targetDirectory
          },
          goExecutable: execution.goExecutable,
          buildFlags: execution.buildFlags,
          programArguments: configuration.get<string[]>('runArguments', []),
          environment: execution.environment,
          enableContentionProfiles: configuration.get<boolean>('enableContentionProfiles', false)
        });
      } else {
        await vscode.commands.executeCommand('gotune.runWithProfiler');
      }
      const statusAfterStart: string = runner.snapshot.status;
      if (statusAfterStart !== 'running') return;
    }
    const target = activeTargetIdentity();
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
    const gitState = scenario.targetDirectory
      ? await readGitState(scenario.targetDirectory)
      : undefined;

    let workloadExecution: vscode.TaskExecution | undefined;
    let completed: boolean;
    try {
      completed = await vscode.window.withProgress(
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
        const workload = await startScenarioWorkload(scenario);
        if (!workload.started) return false;
        workloadExecution = workload.execution;
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
    } finally {
      workloadExecution?.terminate();
    }
    if (!completed) return;
    const runCaptures = sessions.filter((session) =>
      session.scenarioId === scenario.id && session.importedAt >= runStartedAt
    );
    verifyScenarioCaptures(investigation.id, runCaptures);
    let metrics: Record<string, number> = {};
    if (scenario.metricsAdapter && scenario.targetDirectory) {
      try {
        const execution = resolveGoExecutionConfiguration();
        metrics = await collectScenarioMetrics({
          adapter: scenario.metricsAdapter,
          directory: scenario.targetDirectory,
          environment: execution.environment,
          selectedMetrics: scenario.successMetrics
        });
      } catch (error) {
        targetOutput.appendLine(`[GoTune] Metrics collection failed: ${errorMessage(error)}`);
        void vscode.window.showWarningMessage(
          `GoTune: Runtime evidence is available, but business metrics failed: ${errorMessage(error)}`
        );
      }
    }
    const baselineRun = scenario.runs?.[0];
    const runRecord: ScenarioRunRecord = {
      id: `${runStartedAt}-${Math.random().toString(36).slice(2)}`,
      startedAt: runStartedAt,
      finishedAt: Date.now(),
      target,
      captureIds: runCaptures.map((capture) => capture.id),
      metrics,
      gitCommit: gitState?.commit,
      gitDirty: gitState?.dirty,
      gitDiffSummary: gitState?.diffSummary
    };
    scenario.runs = appendScenarioRun(scenario.runs, runRecord);
    scenario.updatedAt = runRecord.finishedAt;
    const latestInvestigation = investigations.find((item) => item.id === investigation.id);
    if (latestInvestigation) {
      replaceInvestigation(addFindingsToInvestigation(
        latestInvestigation,
        scenarioMetricFindings(latestInvestigation.id, runRecord, baselineRun),
        'scenario-metric-'
      ));
    }
    persist();
    scenarioProvider.refresh();
    investigationProvider.refresh();
    findingsProvider.refresh();
    showScenarioResultPanel(scenario.name, runRecord, baselineRun);
    void vscode.commands.executeCommand('gotune.findings.focus');
    void vscode.window.showInformationMessage(
      `GoTune: Scenario "${scenario.name}" finished. Review Findings and source evidence.`
    );
  }

  async function startScenarioWorkload(
    scenario: PerformanceScenario
  ): Promise<{ started: boolean; execution?: vscode.TaskExecution }> {
    if (scenario.workloadKind === 'manual') {
      const action = await vscode.window.showInformationMessage(
        `GoTune: Reproduce "${scenario.name}" during the ${scenario.captureSeconds}s capture window.`,
        { modal: true },
        'Start Capture'
      );
      return { started: action === 'Start Capture' };
    }
    if (scenario.workloadKind === 'vscode-task') {
      const tasks = await vscode.tasks.fetchTasks();
      const task = tasks.find((candidate) => candidate.name === scenario.workload);
      if (!task) throw new Error(`VS Code task "${scenario.workload}" no longer exists`);
      return { started: true, execution: await vscode.tasks.executeTask(task) };
    }
    if (!scenario.workload) throw new Error('Scenario workload command is missing');
    const task = new vscode.Task(
      { type: 'gotune-scenario', scenario: scenario.id },
      vscode.TaskScope.Workspace,
      `GoTune: ${scenario.name}`,
      'GoTune',
      new vscode.ShellExecution(scenario.workload)
    );
    return { started: true, execution: await vscode.tasks.executeTask(task) };
  }

  async function runBenchmarkScenario(scenario: PerformanceScenario): Promise<void> {
    if (!scenario.targetDirectory || !scenario.workload) {
      throw new Error('Benchmark scenario is missing its package directory or benchmark pattern');
    }
    const gitState = await readGitState(scenario.targetDirectory);
    let investigation = investigations.find((item) => item.scenarioId === scenario.id);
    if (!investigation) {
      investigation = createInvestigation(scenario.problem, scenario.target);
      investigation.name = scenario.name;
      investigation.scenarioId = scenario.id;
      investigations.unshift(investigation);
    }
    activeInvestigationId = investigation.id;
    replaceInvestigation(investigation);
    const execution = resolveGoExecutionConfiguration();
    let result;
    try {
      result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `GoTune: benchmarking ${scenario.name}`,
          cancellable: false
        },
        () => runGoBenchmark({
          goExecutable: execution.goExecutable,
          directory: scenario.targetDirectory!,
          environment: execution.environment,
          pattern: scenario.workload!,
          count: scenario.benchmarkCount ?? 5,
          benchtime: scenario.benchmarkTime ?? '1s'
        })
      );
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      targetOutput.appendLine(`[GoTune] Benchmark failed: ${errorMessage(error)}`);
      if (failure.stdout) targetOutput.append(failure.stdout);
      if (failure.stderr) targetOutput.append(failure.stderr);
      targetOutput.show(true);
      throw error;
    }
    targetOutput.appendLine(`[GoTune] Benchmark scenario: ${scenario.name}`);
    targetOutput.append(result.output);
    if (result.measurements.length === 0) {
      targetOutput.show(true);
      throw new Error(`No benchmarks matched ${scenario.workload}`);
    }

    const capturedAt = Date.now();
    const captures: ProfileSession[] = [];
    if (result.cpuProfile) {
      const session = parseProfile(
        result.cpuProfile,
        `${scenario.name} benchmark CPU`,
        `benchmark:${scenario.targetDirectory}`,
        'cpu'
      );
      annotateBenchmarkSession(session, scenario, capturedAt);
      captures.push(session);
      addSession(session, false);
    }
    if (result.memoryProfile) {
      const session = parseProfile(
        result.memoryProfile,
        `${scenario.name} benchmark allocations`,
        `benchmark:${scenario.targetDirectory}`,
        'alloc_space'
      );
      annotateBenchmarkSession(session, scenario, capturedAt);
      captures.push(session);
      addSession(session, false);
    }
    verifyScenarioCaptures(investigation.id, captures);

    const current: BenchmarkSnapshot = {
      capturedAt,
      measurements: result.measurements,
      gitCommit: gitState?.commit,
      gitDirty: gitState?.dirty
    };
    const baseline = scenario.benchmarkBaseline;
    const latestInvestigation = investigations.find((item) => item.id === investigation!.id);
    if (latestInvestigation) {
      replaceInvestigation(addFindingsToInvestigation(
        latestInvestigation,
        benchmarkFindings(latestInvestigation.id, current, baseline),
        'benchmark-'
      ));
    }
    if (!baseline) scenario.benchmarkBaseline = current;
    const runRecord: ScenarioRunRecord = {
      id: `${capturedAt}-${Math.random().toString(36).slice(2)}`,
      startedAt: capturedAt,
      finishedAt: Date.now(),
      target: scenario.target,
      captureIds: captures.map((capture) => capture.id),
      metrics: Object.fromEntries(result.measurements.flatMap((measurement) => [
        ...(measurement.nsPerOp === undefined
          ? []
          : [[`${measurement.name}/ns/op`, measurement.nsPerOp] as const]),
        ...(measurement.bytesPerOp === undefined
          ? []
          : [[`${measurement.name}/B/op`, measurement.bytesPerOp] as const]),
        ...(measurement.allocsPerOp === undefined
          ? []
          : [[`${measurement.name}/allocs/op`, measurement.allocsPerOp] as const])
      ])),
      gitCommit: gitState?.commit,
      gitDirty: gitState?.dirty,
      gitDiffSummary: gitState?.diffSummary
    };
    scenario.runs = appendScenarioRun(scenario.runs, runRecord);
    scenario.updatedAt = capturedAt;
    persist();
    scenarioProvider.refresh();
    showBenchmarkPanel(scenario.name, current, baseline);
    void vscode.commands.executeCommand('gotune.findings.focus');
  }

  function annotateBenchmarkSession(
    session: ProfileSession,
    scenario: PerformanceScenario,
    capturedAt: number
  ): void {
    session.importedAt = capturedAt;
    session.target = scenario.target;
    session.scenarioId = scenario.id;
    session.captureMode = 'delta';
  }

  async function pickScenarioTarget(): Promise<ScenarioTargetChoice | undefined> {
    const execution = resolveGoExecutionConfiguration();
    const launches = goLaunchConfigurations();
    const choices: Array<{
      label: string;
      description: string;
      targetKind: 'main' | 'launch';
      launch?: GoLaunchConfiguration;
    }> = [
      {
        label: 'Current Go main package',
        description: 'Use the open package main when possible',
        targetKind: 'main'
      },
      ...launches.map((launch) => ({
        label: `Launch: ${launch.configuration.name}`,
        description: launch.folder.name,
        targetKind: 'launch' as const,
        launch
      }))
    ];
    const selected = await vscode.window.showQuickPick(choices, {
      title: 'Scenario Target',
      placeHolder: 'Choose exactly how this service should be started'
    });
    if (!selected) return undefined;
    if (selected.targetKind === 'launch' && selected.launch) {
      const target = await resolveLaunchMainPackage(
        selected.launch,
        execution,
        targetOutput
      );
      return {
        identity: launchTargetIdentity(
          selected.launch.folder.uri.fsPath,
          selected.launch.configuration.name
        ),
        target,
        launch: selected.launch
      };
    }
    const target = await selectMainPackage(
      execution.goExecutable,
      execution.environment,
      targetOutput,
      false
    );
    return target ? { identity: target.importPath, target } : undefined;
  }

  async function pickBenchmarkTarget(): Promise<ScenarioTargetChoice | undefined> {
    const editor = vscode.window.activeTextEditor;
    const activeDirectory = editor?.document.languageId === 'go'
      && editor.document.uri.scheme === 'file'
      ? path.dirname(editor.document.uri.fsPath)
      : undefined;
    let directory = activeDirectory;
    if (!directory) {
      const folders = (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === 'file');
      if (folders.length === 1) {
        directory = folders[0].uri.fsPath;
      } else {
        const selected = await vscode.window.showQuickPick(
          folders.map((folder) => ({
            label: folder.name,
            description: folder.uri.fsPath,
            directory: folder.uri.fsPath
          })),
          { title: 'Benchmark Package' }
        );
        directory = selected?.directory;
      }
    }
    if (!directory) return undefined;
    return {
      identity: `benchmark:${directory}`,
      target: {
        importPath: path.basename(directory),
        directory
      }
    };
  }

  async function startLaunchWithProfiler(
    selected?: GoLaunchConfiguration
  ): Promise<void> {
    const launch = selected ?? await pickGoLaunchConfiguration();
    if (!launch) return;
    const execution = resolveGoExecutionConfiguration();
    const target = await resolveLaunchMainPackage(launch, execution, targetOutput);
    const configuration = vscode.workspace.getConfiguration('gotune');
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `GoTune: starting ${launch.configuration.name}`,
        cancellable: false
      },
      () => runner.startDebug({
        target,
        targetIdentity: launchTargetIdentity(
          launch.folder.uri.fsPath,
          launch.configuration.name
        ),
        folder: launch.folder,
        configuration: launch.configuration,
        goExecutable: execution.goExecutable,
        environment: execution.environment,
        enableContentionProfiles: configuration.get<boolean>('enableContentionProfiles', false)
      })
    );
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

  function activeTargetIdentity(): string | undefined {
    return runner.snapshot.targetIdentity ?? runner.snapshot.target?.importPath;
  }

  async function refreshFindingDiagnostics(): Promise<void> {
    findingDiagnostics.clear();
    const investigation = currentInvestigation();
    if (!investigation) return;
    const byUri = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
    for (const finding of investigation.findings) {
      if (
        !finding.location
        || (finding.severity !== 'suspicious' && finding.severity !== 'verified')
      ) {
        continue;
      }
      const uri = await resolveSourceFile(finding.location.file);
      if (!uri) continue;
      const key = uri.toString();
      const entry = byUri.get(key) ?? { uri, diagnostics: [] };
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === key
      );
      const line = Math.max(0, Math.min(
        (document?.lineCount ?? finding.location.line) - 1,
        finding.location.line - 1
      ));
      const range = document
        ? document.lineAt(line).range
        : new vscode.Range(line, 0, line, 1);
      const diagnostic = new vscode.Diagnostic(
        range,
        `${finding.title}: ${finding.detail}`,
        finding.severity === 'suspicious'
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Hint
      );
      diagnostic.source = 'GoTune';
      diagnostic.code = `gotune.${finding.kind}`;
      entry.diagnostics.push(diagnostic);
      byUri.set(key, entry);
    }
    findingDiagnostics.set(
      [...byUri.values()].map((entry) => [entry.uri, entry.diagnostics])
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
  return functionAtDocumentPosition(editor.document, editor.selection.active);
}

async function functionAtDocumentPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<GoFunctionReference | undefined> {
  const functions = await goFunctionsInDocument(document);
  const bySymbol = functions
    .filter((candidate) =>
      position.line + 1 >= candidate.startLine && position.line + 1 <= candidate.endLine
    )
    .sort((left, right) =>
      (left.endLine - left.startLine) - (right.endLine - right.startLine)
    )[0];
  if (bySymbol) return bySymbol;

  for (let start = position.line; start >= 0; start--) {
    const startText = document.lineAt(start).text;
    if (!/^\s*func\b/.test(startText)) continue;
    const signature = Array.from(
      { length: Math.min(8, document.lineCount - start) },
      (_, offset) => document.lineAt(start + offset).text
    ).join(' ');
    const match = /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?\(/.exec(signature);
    if (!match) continue;
    let depth = 0;
    let opened = false;
    for (let end = start; end < document.lineCount; end++) {
      for (const character of document.lineAt(end).text) {
        if (character === '{') {
          depth++;
          opened = true;
        } else if (character === '}') {
          depth--;
        }
      }
      if (opened && depth <= 0) {
        if (position.line > end) break;
        return {
          name: match[1],
          file: document.uri.fsPath,
          startLine: start + 1,
          endLine: end + 1
        };
      }
    }
  }
  return undefined;
}

async function goFunctionsInDocument(
  document: vscode.TextDocument
): Promise<GoFunctionReference[]> {
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider',
    document.uri
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
  return functions.map((symbol) => ({
    name: symbol.name,
    file: document.uri.fsPath,
    startLine: symbol.range.start.line + 1,
    endLine: symbol.range.end.line + 1
  }));
}

interface GoStructReference {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
}

async function structAtEditor(): Promise<GoStructReference | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'go' || editor.document.uri.scheme !== 'file') {
    return undefined;
  }
  return structAtDocumentPosition(editor.document, editor.selection.active);
}

async function structAtDocumentPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<GoStructReference | undefined> {
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider',
    document.uri
  );
  const structs: vscode.DocumentSymbol[] = [];
  const visit = (items: vscode.DocumentSymbol[]): void => {
    for (const item of items) {
      if (item.kind === vscode.SymbolKind.Struct) structs.push(item);
      visit(item.children);
    }
  };
  visit(symbols ?? []);
  const symbol = structs
    .filter((candidate) => candidate.range.contains(position))
    .sort((left, right) =>
      (left.range.end.line - left.range.start.line)
      - (right.range.end.line - right.range.start.line)
    )[0];
  if (symbol) {
    return {
      name: symbol.name,
      file: document.uri.fsPath,
      startLine: symbol.range.start.line + 1,
      endLine: symbol.range.end.line + 1
    };
  }
  for (let start = position.line; start >= 0; start--) {
    const match = /^\s*type\s+([A-Za-z_]\w*)\s+struct\s*\{/.exec(document.lineAt(start).text);
    if (!match) continue;
    let depth = 0;
    let opened = false;
    for (let end = start; end < document.lineCount; end++) {
      for (const character of document.lineAt(end).text) {
        if (character === '{') {
          depth++;
          opened = true;
        } else if (character === '}') {
          depth--;
        }
      }
      if (opened && depth <= 0) {
        if (position.line > end) break;
        return {
          name: match[1],
          file: document.uri.fsPath,
          startLine: start + 1,
          endLine: end + 1
        };
      }
    }
  }
  return undefined;
}

async function applySafeStructLayout(
  uri: vscode.Uri,
  inspectedVersion: number,
  optimizedSource?: string
): Promise<void> {
  if (!optimizedSource) return;
  const document = await vscode.workspace.openTextDocument(uri);
  if (document.isDirty || document.version !== inspectedVersion) {
    void vscode.window.showWarningMessage(
      'GoTune: The source changed after layout inspection. Inspect the struct again before applying.'
    );
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
    optimizedSource
  );
  if (!await vscode.workspace.applyEdit(edit)) {
    throw new Error('VS Code could not apply the safe struct layout');
  }
  const updated = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(updated, { preview: false });
  void vscode.window.showInformationMessage(
    'GoTune: Applied the verified field reorder. Review and run the same benchmark scenario.'
  );
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
  const investigation = investigations.find((item) => item.id === activeInvestigationId);
  const captureIds = new Set(investigation?.captureIds ?? []);
  const evidenceSessions = investigation
    ? sessions.filter((session) => captureIds.has(session.id))
    : activeSession ? [activeSession] : [];
  const grouped = new Map<number, Array<{
    session: ProfileSession;
    metric: ProfileSession['lineMetrics'][number];
    kind: EvidenceKind;
  }>>();
  for (const session of evidenceSessions) {
    for (const metric of session.lineMetrics) {
      if (!sameSource(uri.fsPath, metric.file)) continue;
      const line = Math.max(0, Math.min(document.lineCount - 1, metric.line - 1));
      const kind = profileEvidenceKind(session.sampleType);
      const entries = grouped.get(line) ?? [];
      if (!entries.some((entry) => entry.kind === kind)) {
        entries.push({ session, metric, kind });
        grouped.set(line, entries);
      }
    }
  }
  const lineDecorations = [...grouped.entries()].map(([line, entries]) => {
    const metricLine = Math.max(0, Math.min(document.lineCount - 1, line));
    const hover = entries.flatMap(({ session, metric, kind }) => {
      const percent = session.total ? metric.value / session.total * 100 : 0;
      const selfPercent = session.total && metric.flat !== undefined
        ? metric.flat / session.total * 100
        : undefined;
      return [
        `### ${functionEvidenceKindLabel(kind)} · ${metric.functionName}`,
        kind === 'live-memory'
          ? `Produced by this allocation path and still live: **${formatValue(metric.value, session.sampleUnit)}** (${percent.toFixed(1)}% of profile)`
          : `Self: **${metric.flat === undefined ? 'not recorded' : `${formatValue(metric.flat, session.sampleUnit)}${selfPercent === undefined ? '' : ` (${selfPercent.toFixed(1)}%)`}`}**  \nWith callees: **${formatValue(metric.value, session.sampleUnit)} (${percent.toFixed(1)}%)**`,
        ''
      ];
    });
    return {
      range: document.lineAt(metricLine).range,
      hoverMessage: `${hover.join('\n\n')}\n\n_With callees includes sampled work in functions called from this line. Live heap is attributed to an allocation path, not an object owner._`
    };
  });
  const labels = [...grouped.entries()].map(([line, entries]) => {
    const metricLine = Math.max(0, Math.min(document.lineCount - 1, line));
    const lineRange = document.lineAt(metricLine).range;
    const parts = entries.map(({ session, metric, kind }) => {
      const percent = session.total ? metric.value / session.total * 100 : 0;
      if (kind === 'cpu') {
        const self = metric.flat === undefined || !session.total
          ? undefined
          : metric.flat / session.total * 100;
        return self && self > 0
          ? `CPU ${self.toFixed(1)}% self`
          : `CPU ${percent.toFixed(1)}% incl`;
      }
      if (kind === 'allocation') return `Alloc ${formatValue(metric.value, session.sampleUnit)}`;
      if (kind === 'live-memory') return `Live path ${formatValue(metric.value, session.sampleUnit)}`;
      if (kind === 'blocking') return `Wait ${formatValue(metric.value, session.sampleUnit)}`;
      return `${functionEvidenceKindLabel(kind)} ${percent.toFixed(1)}%`;
    });
    const intensity = Math.max(...entries.map(({ session, metric }) =>
      session.total ? Math.min(1, metric.value / session.total) : 0
    ));
    return {
      range: new vscode.Range(lineRange.end, lineRange.end),
      renderOptions: {
        after: {
          contentText: ` GoTune · ${parts.join(' · ')}`,
          opacity: String(0.45 + 0.55 * intensity)
        }
      }
    };
  });
  editor.setDecorations(heatDecoration, lineDecorations);
  editor.setDecorations(heatLabelDecoration, labels);
}

function sameSource(left: string, right: string): boolean {
  return sourcePathsMatch(left, right, configuredSourcePathMappings());
}

function configuredSourcePathMappings(): Record<string, string> {
  return vscode.workspace
    .getConfiguration('gotune')
    .get<Record<string, string>>('sourcePathMappings', {});
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

function traceProfileLabel(kind: TraceProfileKind): string {
  if (kind === 'net') return 'network wait';
  if (kind === 'sync') return 'synchronization wait';
  if (kind === 'syscall') return 'syscall wait';
  return 'scheduler wait';
}

function latestFunctionEvidence(items: FunctionEvidenceItem[]): FunctionEvidenceItem[] {
  const seen = new Set<EvidenceKind>();
  return items.filter((item) => {
    if (seen.has(item.kind)) return false;
    seen.add(item.kind);
    return true;
  });
}

function activeBaselineSessionIds(): string[] {
  const investigation = investigations.find((item) => item.id === activeInvestigationId);
  return [...new Set([
    ...(baselineSessionId ? [baselineSessionId] : []),
    ...Object.values(investigation?.baselineByMetric ?? {})
  ])];
}

function functionEvidenceSummary(items: FunctionEvidenceItem[]): string {
  const parts = latestFunctionEvidence(items).slice(0, 3).map((item) => {
    if (item.kind === 'cpu') return `CPU ${item.selfPercent.toFixed(1)}% self`;
    if (item.kind === 'allocation') {
      return `Alloc ${formatValue(item.cumulative, item.sampleUnit)}`;
    }
    if (item.kind === 'live-memory') {
      return `Live path ${formatValue(item.cumulative, item.sampleUnit)}`;
    }
    if (item.kind === 'blocking') {
      return `Wait ${formatValue(item.cumulative, item.sampleUnit)}`;
    }
    return `${functionEvidenceKindLabel(item.kind)} ${item.cumulativePercent.toFixed(1)}%`;
  });
  return `GoTune · ${parts.join(' · ')}`;
}

function functionEvidenceKindLabel(kind: EvidenceKind): string {
  if (kind === 'cpu') return 'CPU';
  if (kind === 'allocation') return 'allocation';
  if (kind === 'live-memory') return 'live heap path';
  if (kind === 'blocking') return 'blocking';
  if (kind === 'goroutine') return 'goroutine';
  return 'trace';
}

function functionEvidenceDeltaText(percent?: number): string {
  if (percent === undefined) return '';
  return `, baseline ${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

function findingFromInput(
  input?: InvestigationFindingItem | PerformanceFinding
): PerformanceFinding | undefined {
  if (!input) return undefined;
  return input instanceof InvestigationFindingItem ? input.finding : input;
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

function benchmarkFindings(
  investigationId: string,
  current: BenchmarkSnapshot,
  baseline?: BenchmarkSnapshot
): PerformanceFinding[] {
  if (!baseline) {
    return [{
      id: `benchmark-${current.capturedAt}-baseline`,
      investigationId,
      kind: 'cpu',
      severity: 'info',
      title: 'Benchmark baseline captured',
      detail: `${current.measurements.length} benchmark(s) recorded with CPU and allocation evidence.`,
      createdAt: current.capturedAt
    }];
  }
  const baselineByName = new Map(
    baseline.measurements.map((measurement) => [measurement.name, measurement])
  );
  return current.measurements.map((measurement) => {
    const before = baselineByName.get(measurement.name);
    const metrics = [
      benchmarkMetricDelta('ns/op', before?.nsPerOp, measurement.nsPerOp),
      benchmarkMetricDelta('B/op', before?.bytesPerOp, measurement.bytesPerOp),
      benchmarkMetricDelta('allocs/op', before?.allocsPerOp, measurement.allocsPerOp)
    ].filter((value): value is { text: string; percent: number } => Boolean(value));
    const worst = Math.max(0, ...metrics.map((metric) => metric.percent));
    const best = Math.min(0, ...metrics.map((metric) => metric.percent));
    return {
      id: `benchmark-${current.capturedAt}-${measurement.name}`,
      investigationId,
      kind: 'cpu',
      severity: worst >= 5 ? 'suspicious' : best <= -5 ? 'verified' : 'info',
      title: worst >= 5
        ? `${measurement.name} regressed`
        : best <= -5 ? `${measurement.name} improved` : `${measurement.name} is stable`,
      detail: metrics.length > 0
        ? metrics.map((metric) => metric.text).join(' · ')
        : 'No matching baseline measurement was available.',
      functionName: measurement.name.replace(/^Benchmark/, ''),
      createdAt: current.capturedAt
    };
  });
}

function scenarioMetricFindings(
  investigationId: string,
  current: ScenarioRunRecord,
  baseline?: ScenarioRunRecord
): PerformanceFinding[] {
  if (Object.keys(current.metrics).length === 0) return [];
  if (!baseline) {
    return [{
      id: `scenario-metric-${current.id}-baseline`,
      investigationId,
      kind: 'cpu',
      severity: 'info',
      title: 'Business metric baseline captured',
      detail: Object.entries(current.metrics)
        .map(([name, value]) => `${name}=${value.toLocaleString()}`)
        .join(' · '),
      createdAt: current.finishedAt
    }];
  }
  return Object.entries(current.metrics).flatMap(([name, after]) => {
    const before = baseline.metrics[name];
    if (before === undefined) return [];
    const percent = before === 0 ? (after === 0 ? 0 : 100) : (after - before) / before * 100;
    const lowerIsBetter = /(?:latency|p\d+|error|cpu|alloc|heap|memory|mutex|block|goroutine)/i.test(name);
    const improvement = lowerIsBetter ? -percent : percent;
    return [{
      id: `scenario-metric-${current.id}-${name}`,
      investigationId,
      kind: 'cpu' as const,
      severity: improvement >= 5
        ? 'verified' as const
        : improvement <= -5 ? 'suspicious' as const : 'info' as const,
      title: improvement >= 5
        ? `${name} improved`
        : improvement <= -5 ? `${name} regressed` : `${name} is stable`,
      detail: `${before.toLocaleString()} → ${after.toLocaleString()} (${percent > 0 ? '+' : ''}${percent.toFixed(1)}%)`,
      createdAt: current.finishedAt
    }];
  });
}

function appendScenarioRun(
  existing: ScenarioRunRecord[] | undefined,
  current: ScenarioRunRecord
): ScenarioRunRecord[] {
  if (!existing || existing.length === 0) return [current];
  return [existing[0], ...existing.slice(-8), current]
    .filter((run, index, all) => all.findIndex((candidate) => candidate.id === run.id) === index);
}

function benchmarkMetricDelta(
  label: string,
  before?: number,
  after?: number
): { text: string; percent: number } | undefined {
  if (before === undefined || after === undefined) return undefined;
  const percent = before === 0 ? (after === 0 ? 0 : 100) : (after - before) / before * 100;
  return {
    text: `${label} ${before.toLocaleString()} → ${after.toLocaleString()} (${percent > 0 ? '+' : ''}${percent.toFixed(1)}%)`,
    percent
  };
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

interface GoLaunchConfiguration {
  folder: vscode.WorkspaceFolder;
  configuration: vscode.DebugConfiguration & { name: string };
}

interface ScenarioTargetChoice {
  identity: string;
  target: MainPackage;
  launch?: GoLaunchConfiguration;
}

function goLaunchConfigurations(): GoLaunchConfiguration[] {
  const result: GoLaunchConfiguration[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    const configurations = vscode.workspace
      .getConfiguration('launch', folder.uri)
      .get<vscode.DebugConfiguration[]>('configurations', []);
    for (const configuration of configurations) {
      if (
        configuration.type !== 'go'
        || configuration.request !== 'launch'
        || typeof configuration.name !== 'string'
      ) {
        continue;
      }
      result.push({
        folder,
        configuration: configuration as vscode.DebugConfiguration & { name: string }
      });
    }
  }
  return result;
}

async function pickGoLaunchConfiguration(): Promise<GoLaunchConfiguration | undefined> {
  const configurations = goLaunchConfigurations();
  if (configurations.length === 0) {
    throw new Error(
      'No Go launch configuration was found. Add a Go "launch" entry to .vscode/launch.json first.'
    );
  }
  if (configurations.length === 1) return configurations[0];
  const selected = await vscode.window.showQuickPick(
    configurations.map((launch) => ({
      label: launch.configuration.name,
      description: launch.folder.name,
      launch
    })),
    {
      title: 'Run Launch Configuration with Profiler',
      placeHolder: 'GoTune preserves its program, arguments, environment, and debug settings'
    }
  );
  return selected?.launch;
}

async function resolveLaunchMainPackage(
  launch: GoLaunchConfiguration,
  execution: GoExecutionConfiguration,
  output: vscode.OutputChannel
): Promise<MainPackage> {
  const program = launch.configuration.program;
  if (typeof program !== 'string' || !program.trim()) {
    throw new Error(`Launch configuration "${launch.configuration.name}" has no program`);
  }
  const activeFile = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
    ? vscode.window.activeTextEditor.document.uri.fsPath
    : undefined;
  const substitutions: Record<string, string | undefined> = {
    '${workspaceFolder}': launch.folder.uri.fsPath,
    '${workspaceFolderBasename}': path.basename(launch.folder.uri.fsPath),
    '${file}': activeFile,
    '${fileDirname}': activeFile ? path.dirname(activeFile) : undefined
  };
  let resolvedProgram = program;
  for (const [variable, value] of Object.entries(substitutions)) {
    if (resolvedProgram.includes(variable)) {
      if (!value) {
        throw new Error(
          `Launch configuration "${launch.configuration.name}" uses ${variable}, but no Go file is active`
        );
      }
      resolvedProgram = resolvedProgram.replaceAll(variable, value);
    }
  }
  if (/\$\{(?:env|command|input|config):/.test(resolvedProgram)) {
    throw new Error(
      `Launch configuration "${launch.configuration.name}" uses a dynamic program path that GoTune cannot safely resolve`
    );
  }
  if (!path.isAbsolute(resolvedProgram)) {
    resolvedProgram = path.resolve(launch.folder.uri.fsPath, resolvedProgram);
  }
  if (resolvedProgram.endsWith('.go')) {
    throw new Error(
      `Launch configuration "${launch.configuration.name}" runs a single Go file. Change "program" to its package directory so GoTune can inject the profiler safely.`
    );
  }
  const target = await resolveMainPackage(
    execution.goExecutable,
    resolvedProgram,
    execution.environment,
    output
  );
  if (!target) {
    throw new Error(
      `Launch configuration "${launch.configuration.name}" does not resolve to a Go package main`
    );
  }
  return target;
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
