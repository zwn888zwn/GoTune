import { ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { shouldCreateProcessGroup, signalProcessTree } from './processTree';

const execFileAsync = promisify(execFile);

interface Output {
  append(value: string): void;
  appendLine(value: string): void;
}

export class TraceViewer {
  private child: ChildProcessWithoutNullStreams | undefined;
  private tempDirectory: string | undefined;

  constructor(private readonly output: Output) {}

  async ensureAvailable(
    goExecutable: string,
    environment: Record<string, string>
  ): Promise<void> {
    const result = await execFileAsync(goExecutable, ['tool'], {
      env: { ...process.env, ...environment },
      maxBuffer: 1024 * 1024
    });
    if (!result.stdout.split(/\r?\n/).includes('trace')) {
      throw new Error(
        'The selected Go installation does not include go tool trace. Install a complete matching Go toolchain to view execution traces.'
      );
    }
  }

  async open(
    trace: Buffer,
    goExecutable: string,
    environment: Record<string, string>
  ): Promise<string> {
    await this.stop();
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gotune-trace-'));
    this.tempDirectory = temporaryDirectory;
    const tracePath = path.join(temporaryDirectory, 'execution.trace');
    await fs.writeFile(tracePath, trace, { mode: 0o600 });

    const args = ['tool', 'trace', '-http=127.0.0.1:0', tracePath];
    this.output.appendLine(`[GoTune] Opening execution trace: ${goExecutable} ${args.join(' ')}`);
    const child = spawn(goExecutable, args, {
      env: {
        ...process.env,
        ...environment,
        ...(process.platform === 'win32' ? {} : { BROWSER: '/usr/bin/true' })
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: shouldCreateProcessGroup()
    });
    this.child = child;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let output = '';
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        void this.stop();
        reject(new Error('Timed out waiting for go tool trace to start'));
      }, 30_000);
      const consume = (chunk: Buffer) => {
        const text = chunk.toString();
        this.output.append(text);
        output = `${output}${text}`.slice(-8000);
        const url = traceViewerUrl(output);
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
        reject(error);
      });
      child.on('exit', (code, signal) => {
        if (this.child === child) this.child = undefined;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          const detail = output.trim().split(/\r?\n/).at(-1);
          reject(new Error(
            detail || `go tool trace exited before opening the viewer (code=${code}, signal=${signal})`
          ));
        }
        void this.cleanup();
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child) signalProcessTree(child, 'SIGTERM');
    await this.cleanup();
  }

  dispose(): void {
    void this.stop();
  }

  private async cleanup(): Promise<void> {
    const temporaryDirectory = this.tempDirectory;
    this.tempDirectory = undefined;
    if (temporaryDirectory) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export function traceViewerUrl(output: string): string | undefined {
  return /\bhttps?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\S*/.exec(output)?.[0]
    .replace(/[),.;]+$/, '');
}
