import { ChildProcess } from 'node:child_process';

type KillableProcess = Pick<ChildProcess, 'pid' | 'kill' | 'exitCode' | 'signalCode'>;
type KillProcess = (pid: number, signal?: NodeJS.Signals | number) => boolean;

export function shouldCreateProcessGroup(platform = process.platform): boolean {
  return platform !== 'win32';
}

export function signalProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals,
  platform = process.platform,
  killProcess: KillProcess = process.kill
): boolean {
  if (platform !== 'win32' && child.pid) {
    try {
      return killProcess(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  return child.kill(signal);
}

export function isProcessTreeAlive(
  child: KillableProcess,
  platform = process.platform,
  killProcess: KillProcess = process.kill
): boolean {
  if (platform !== 'win32' && child.pid) {
    try {
      killProcess(-child.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  }
  return child.exitCode === null && child.signalCode === null;
}
