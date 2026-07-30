import { ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { createAgentSource, errorMarkerPrefix, markerPrefix } from './agent';
import { parseMainPackageOutput } from './goSource';
import { withProfilerBuildFlags } from './launch';
import { isProcessTreeAlive, shouldCreateProcessGroup, signalProcessTree } from './processTree';

const execFileAsync = promisify(execFile);

export type RunnerStatus = 'idle' | 'starting' | 'running' | 'stopping';

export interface MainPackage {
  importPath: string;
  directory: string;
  fromActiveEditor?: boolean;
}

export interface RunnerSnapshot {
  status: RunnerStatus;
  target?: MainPackage;
  targetIdentity?: string;
  pid?: number;
  pprofUrl?: string;
  startedAt?: number;
  contentionProfilesEnabled?: boolean;
}

export interface StartOptions {
  target: MainPackage;
  goExecutable: string;
  buildFlags: string[];
  programArguments: string[];
  environment: Record<string, string>;
  enableContentionProfiles: boolean;
}

export interface DebugStartOptions {
  target: MainPackage;
  targetIdentity: string;
  folder: vscode.WorkspaceFolder;
  configuration: vscode.DebugConfiguration;
  goExecutable: string;
  environment: Record<string, string>;
  enableContentionProfiles: boolean;
}

export class ProfilerRunner implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<RunnerSnapshot>();
  readonly onDidChange = this.emitter.event;

  private child: ChildProcessWithoutNullStreams | undefined;
  private debugSession: vscode.DebugSession | undefined;
  private debugMarker: string | undefined;
  private readonly debugSubscriptions: vscode.Disposable[];
  private tempDirectory: string | undefined;
  private snapshotValue: RunnerSnapshot = { status: 'idle' };
  private stopRequested = false;

  constructor(private readonly output: vscode.OutputChannel) {
    this.debugSubscriptions = [
      vscode.debug.onDidStartDebugSession((session) => {
        if (session.configuration.__gotuneProfilerMarker === this.debugMarker) {
          this.debugSession = session;
        }
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        if (session.id !== this.debugSession?.id) return;
        this.output.appendLine(`[GoTune] Debug target "${session.name}" stopped.`);
        this.finish();
      })
    ];
  }

  get snapshot(): RunnerSnapshot {
    return this.snapshotValue;
  }

  async start(options: StartOptions): Promise<RunnerSnapshot> {
    if (this.snapshotValue.status !== 'idle') {
      throw new Error('A GoTune target is already running');
    }
    this.stopRequested = false;
    const startedAt = Date.now();
    this.setSnapshot({
      status: 'starting',
      target: options.target,
      targetIdentity: options.target.importPath,
      startedAt,
      contentionProfilesEnabled: options.enableContentionProfiles
    });
    this.output.show(true);
    this.output.appendLine(`[GoTune] Starting ${options.target.importPath}`);

    const token = randomBytes(24).toString('hex');
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gotune-run-'));
    this.tempDirectory = temporaryDirectory;
    const agentPath = path.join(temporaryDirectory, 'gotune_agent.go');
    const overlayPath = path.join(temporaryDirectory, 'overlay.json');
    const virtualPath = path.join(options.target.directory, 'zz_gotune_profiler.go');
    try {
      await fs.access(virtualPath);
      throw new Error(`${virtualPath} already exists; GoTune will not overwrite it`);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      if (failure.code !== 'ENOENT') throw error;
    }
    await fs.writeFile(
      agentPath,
      createAgentSource(token, options.enableContentionProfiles),
      { encoding: 'utf8', mode: 0o600 }
    );
    await fs.writeFile(
      overlayPath,
      JSON.stringify({ Replace: { [virtualPath]: agentPath } }, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );

    const buildFlags = [...options.buildFlags];
    if (await needsNetgoCompatibility(options.goExecutable, options.environment) && !hasTagsFlag(buildFlags)) {
      buildFlags.push('-tags=netgo');
      this.output.appendLine('[GoTune] Added -tags=netgo for Go 1.19 or older on macOS.');
    }
    if (options.enableContentionProfiles) {
      this.output.appendLine('[GoTune] Enabled block and mutex sampling for this profiled run.');
    }
    const args = ['run', ...buildFlags, `-overlay=${overlayPath}`, '.', ...options.programArguments];
    this.output.appendLine(`[GoTune] cwd: ${options.target.directory}`);
    this.output.appendLine(`[GoTune] command: ${options.goExecutable} ${args.map(shellDisplay).join(' ')}`);

    const child = spawn(options.goExecutable, args, {
      cwd: options.target.directory,
      env: { ...process.env, ...options.environment },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: shouldCreateProcessGroup()
    });
    this.child = child;
    this.setSnapshot({
      status: 'starting',
      target: options.target,
      targetIdentity: options.target.importPath,
      pid: child.pid,
      startedAt,
      contentionProfilesEnabled: options.enableContentionProfiles
    });

    child.stdout.on('data', (chunk: Buffer) => this.output.append(chunk.toString()));
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.output.append(text);
      stderrBuffer += text;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith(markerPrefix)) {
          this.setSnapshot({
            status: 'running',
            target: options.target,
            targetIdentity: options.target.importPath,
            pid: child.pid,
            pprofUrl: line.slice(markerPrefix.length).trim(),
            startedAt,
            contentionProfilesEnabled: options.enableContentionProfiles
          });
        } else if (line.startsWith(errorMarkerPrefix)) {
          this.output.appendLine(`[GoTune] Profiler injection failed: ${line.slice(errorMarkerPrefix.length)}`);
        }
      }
    });
    child.on('error', (error) => {
      this.output.appendLine(`[GoTune] Failed to start: ${error.message}`);
      this.finish();
    });
    child.on('exit', (code, signal) => {
      this.output.appendLine(`[GoTune] Target exited (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`);
      const unexpected = !this.stopRequested && this.snapshotValue.status !== 'idle';
      this.finish();
      if (unexpected) {
        void vscode.window.showWarningMessage('GoTune: The profiled target exited. See GoTune Target output.');
      }
    });

    return new Promise<RunnerSnapshot>((resolve, reject) => {
      const timeout = setTimeout(() => {
        subscription.dispose();
        void this.stop();
        reject(new Error('Timed out waiting for the injected pprof server to start'));
      }, 30_000);
      const subscription = this.onDidChange((snapshot) => {
        if (snapshot.status === 'running') {
          clearTimeout(timeout);
          subscription.dispose();
          resolve(snapshot);
        } else if (snapshot.status === 'idle') {
          clearTimeout(timeout);
          subscription.dispose();
          reject(new Error('The target exited before its pprof server became ready'));
        }
      });
    });
  }

  async startDebug(options: DebugStartOptions): Promise<RunnerSnapshot> {
    if (this.snapshotValue.status !== 'idle') {
      throw new Error('A GoTune target is already running');
    }
    this.stopRequested = false;
    const startedAt = Date.now();
    this.setSnapshot({
      status: 'starting',
      target: options.target,
      targetIdentity: options.targetIdentity,
      startedAt,
      contentionProfilesEnabled: options.enableContentionProfiles
    });
    this.output.show(true);
    this.output.appendLine(`[GoTune] Starting launch configuration "${options.configuration.name}"`);

    const token = randomBytes(24).toString('hex');
    const listenAddress = await availableLoopbackAddress();
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gotune-debug-'));
    this.tempDirectory = temporaryDirectory;
    const overlayPath = await createProfilerOverlay(
      temporaryDirectory,
      options.target.directory,
      token,
      options.enableContentionProfiles,
      listenAddress
    );
    const extraBuildFlags = [`-overlay=${overlayPath}`];
    if (await needsNetgoCompatibility(options.goExecutable, options.environment)) {
      extraBuildFlags.push('-tags=netgo');
      this.output.appendLine('[GoTune] Added -tags=netgo for Go 1.19 or older on macOS.');
    }
    const marker = randomBytes(16).toString('hex');
    this.debugMarker = marker;
    const configuration = withProfilerBuildFlags(options.configuration, extraBuildFlags);
    configuration.name = `GoTune: ${options.configuration.name}`;
    configuration.__gotuneProfilerMarker = marker;
    this.output.appendLine(`[GoTune] launch target: ${options.target.directory}`);
    this.output.appendLine(`[GoTune] profiler: http://${listenAddress}/debug/pprof/`);
    if (options.enableContentionProfiles) {
      this.output.appendLine('[GoTune] Enabled block and mutex sampling for this debug run.');
    }

    const started = await vscode.debug.startDebugging(options.folder, configuration);
    if (!started) {
      this.finish();
      throw new Error(`VS Code could not start launch configuration "${options.configuration.name}"`);
    }
    try {
      const pprofUrl = `http://${listenAddress}/debug/pprof/?token=${token}`;
      await waitForProfiler(pprofUrl, 30_000);
      this.setSnapshot({
        status: 'running',
        target: options.target,
        targetIdentity: options.targetIdentity,
        startedAt,
        pprofUrl,
        contentionProfilesEnabled: options.enableContentionProfiles
      });
      return this.snapshotValue;
    } catch (error) {
      if (this.debugSession) {
        await vscode.debug.stopDebugging(this.debugSession);
      }
      this.finish();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.debugSession) {
      this.stopRequested = true;
      this.setSnapshot({ ...this.snapshotValue, status: 'stopping' });
      const session = this.debugSession;
      await vscode.debug.stopDebugging(session);
      return;
    }
    const child = this.child;
    if (!child) {
      this.finish();
      return;
    }
    this.stopRequested = true;
    this.setSnapshot({ ...this.snapshotValue, status: 'stopping' });
    signalProcessTree(child, 'SIGTERM');
    const exited = await waitForProcessTreeExit(child, 3000);
    if (!exited) {
      this.output.appendLine('[GoTune] Target did not stop after 3 seconds; killing its process tree.');
      signalProcessTree(child, 'SIGKILL');
      await waitForProcessTreeExit(child, 1000);
    }
  }

  dispose(): void {
    if (this.child) {
      this.stopRequested = true;
      signalProcessTree(this.child, 'SIGTERM');
    }
    if (this.debugSession) {
      void vscode.debug.stopDebugging(this.debugSession);
    }
    for (const subscription of this.debugSubscriptions) subscription.dispose();
    this.emitter.dispose();
    void this.cleanup();
  }

  private setSnapshot(snapshot: RunnerSnapshot): void {
    this.snapshotValue = snapshot;
    this.emitter.fire(snapshot);
  }

  private finish(): void {
    this.child = undefined;
    this.debugSession = undefined;
    this.debugMarker = undefined;
    this.setSnapshot({ status: 'idle' });
    void this.cleanup();
  }

  private async cleanup(): Promise<void> {
    const temporaryDirectory = this.tempDirectory;
    this.tempDirectory = undefined;
    if (temporaryDirectory) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

async function createProfilerOverlay(
  temporaryDirectory: string,
  targetDirectory: string,
  token: string,
  enableContentionProfiles: boolean,
  listenAddress: string
): Promise<string> {
  const agentPath = path.join(temporaryDirectory, 'gotune_agent.go');
  const overlayPath = path.join(temporaryDirectory, 'overlay.json');
  const virtualPath = path.join(targetDirectory, 'zz_gotune_profiler.go');
  try {
    await fs.access(virtualPath);
    throw new Error(`${virtualPath} already exists; GoTune will not overwrite it`);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code !== 'ENOENT') throw error;
  }
  await fs.writeFile(
    agentPath,
    createAgentSource(token, enableContentionProfiles, listenAddress),
    { encoding: 'utf8', mode: 0o600 }
  );
  await fs.writeFile(
    overlayPath,
    JSON.stringify({ Replace: { [virtualPath]: agentPath } }, null, 2),
    { encoding: 'utf8', mode: 0o600 }
  );
  return overlayPath;
}

function availableLoopbackAddress(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a localhost profiler port'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(`127.0.0.1:${address.port}`);
      });
    });
  });
}

async function waitForProfiler(pprofUrl: string, timeoutMilliseconds: number): Promise<void> {
  const runtimeUrl = new URL(pprofUrl);
  runtimeUrl.pathname = '/debug/gotune/runtime';
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError = 'target did not accept profiler requests';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(runtimeUrl, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = `profiler returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the injected pprof server: ${lastError}`);
}

async function waitForProcessTreeExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMilliseconds: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (isProcessTreeAlive(child)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

export async function discoverMainPackages(
  goExecutable: string,
  workspaceDirectories: string[],
  environment: Record<string, string>,
  output: vscode.OutputChannel
): Promise<MainPackage[]> {
  const packages = new Map<string, MainPackage>();
  for (const directory of workspaceDirectories) {
    try {
      const result = await execFileAsync(
        goExecutable,
        ['list', '-f', '{{if eq .Name "main"}}{{.ImportPath}}\t{{.Dir}}{{end}}', './...'],
        { cwd: directory, env: { ...process.env, ...environment }, maxBuffer: 8 * 1024 * 1024 }
      );
      for (const line of result.stdout.split(/\r?\n/)) {
        const parsed = parseMainPackageOutput(line);
        if (parsed) {
          packages.set(parsed.directory, parsed);
        }
      }
    } catch (error) {
      const failure = error as { stderr?: string; message?: string };
      output.appendLine(`[GoTune] Could not scan ${directory}: ${failure.stderr?.trim() || failure.message}`);
    }
  }
  return [...packages.values()].sort((left, right) => left.importPath.localeCompare(right.importPath));
}

export async function resolveMainPackage(
  goExecutable: string,
  directory: string,
  environment: Record<string, string>,
  output: vscode.OutputChannel
): Promise<MainPackage | undefined> {
  try {
    const result = await execFileAsync(
      goExecutable,
      ['list', '-f', '{{if eq .Name "main"}}{{.ImportPath}}\t{{.Dir}}{{end}}', '.'],
      { cwd: directory, env: { ...process.env, ...environment }, maxBuffer: 2 * 1024 * 1024 }
    );
    return parseMainPackageOutput(result.stdout);
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    output.appendLine(
      `[GoTune] Current editor package could not be resolved: ${failure.stderr?.trim() || failure.message}`
    );
  }
  return undefined;
}

async function needsNetgoCompatibility(
  goExecutable: string,
  environment: Record<string, string>
): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    const result = await execFileAsync(goExecutable, ['version'], {
      env: { ...process.env, ...environment },
      maxBuffer: 1024 * 1024
    });
    const match = /\bgo(\d+)\.(\d+)/.exec(result.stdout);
    return Boolean(match && Number(match[1]) === 1 && Number(match[2]) <= 19);
  } catch {
    return false;
  }
}

function hasTagsFlag(flags: string[]): boolean {
  return flags.some((flag) => flag === '-tags' || flag.startsWith('-tags='));
}

function shellDisplay(value: string): string {
  return /^[a-zA-Z0-9_./:=?&-]+$/.test(value) ? value : JSON.stringify(value);
}
