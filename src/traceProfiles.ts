import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export type TraceProfileKind = 'net' | 'sync' | 'syscall' | 'sched';

export async function deriveTraceProfiles(
  trace: Buffer,
  goExecutable: string,
  environment: Record<string, string>
): Promise<Array<{ kind: TraceProfileKind; bytes: Buffer }>> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gotune-trace-profiles-'));
  const tracePath = path.join(temporaryDirectory, 'execution.trace');
  try {
    await fs.writeFile(tracePath, trace, { mode: 0o600 });
    const kinds: TraceProfileKind[] = ['net', 'sync', 'syscall', 'sched'];
    const results = await Promise.all(kinds.map(async (kind) => ({
      kind,
      bytes: await execFileBuffer(
        goExecutable,
        ['tool', 'trace', `-pprof=${kind}`, tracePath],
        environment
      )
    })));
    return results.filter((result) => result.bytes.length > 0);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function execFileBuffer(
  executable: string,
  args: string[],
  environment: Record<string, string>
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        env: { ...process.env, ...environment },
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 2 * 60 * 1000
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim() : String(stderr);
          reject(new Error(detail || error.message));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      }
    );
  });
}
