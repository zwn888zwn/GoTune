import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitState {
  commit: string;
  dirty: boolean;
  diffSummary?: string;
}

export async function readGitState(directory: string): Promise<GitState | undefined> {
  try {
    const commit = await execFileAsync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
      maxBuffer: 1024 * 1024
    });
    const status = await execFileAsync(
      'git',
      ['-C', directory, 'status', '--porcelain', '--untracked-files=no'],
      { maxBuffer: 4 * 1024 * 1024 }
    );
    let diffSummary: string | undefined;
    if (status.stdout.trim()) {
      const diff = await execFileAsync(
        'git',
        ['-C', directory, 'diff', '--stat', '--compact-summary'],
        { maxBuffer: 4 * 1024 * 1024 }
      );
      diffSummary = diff.stdout.trim() || undefined;
    }
    return {
      commit: commit.stdout.trim(),
      dirty: Boolean(status.stdout.trim()),
      diffSummary
    };
  } catch {
    return undefined;
  }
}
