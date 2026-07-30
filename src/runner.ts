import { ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { createAgentSource, errorMarkerPrefix, markerPrefix } from './agent';
import { parseMainPackageOutput } from './goSource';
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
  pid?: number;
  pprofUrl?: string;
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

export class ProfilerRunner implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<RunnerSnapshot>();
  readonly onDidChange = this.emitter.event;

  private child: ChildProcessWithoutNullStreams | undefined;
  private tempDirectory: string | undefined;
  private snapshotValue: RunnerSnapshot = { status: 'idle' };
  private stopRequested = false;

  constructor(private readonly output: vscode.OutputChannel) {}

  get snapshot(): RunnerSnapshot {
    return this.snapshotValue;
  }

  async start(options: StartOptions): Promise<RunnerSnapshot> {
    if (this.child) {
      throw new Error('A GoTune target is already running');
    }
    this.stopRequested = false;
    this.setSnapshot({
      status: 'starting',
      target: options.target,
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
      pid: child.pid,
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
            pid: child.pid,
            pprofUrl: line.slice(markerPrefix.length).trim(),
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

  async stop(): Promise<void> {
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
    this.emitter.dispose();
    void this.cleanup();
  }

  private setSnapshot(snapshot: RunnerSnapshot): void {
    this.snapshotValue = snapshot;
    this.emitter.fire(snapshot);
  }

  private finish(): void {
    this.child = undefined;
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
