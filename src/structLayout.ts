import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface StructLayoutField {
  name: string;
  type: string;
  offset: number;
  size: number;
  align: number;
  padding: number;
}

export interface StructLayoutResult {
  name: string;
  file: string;
  line: number;
  size: number;
  optimizedSize: number;
  fields: StructLayoutField[];
  optimizedFields: StructLayoutField[];
  safeToApply: boolean;
  safetyReasons?: string[];
  optimizedSource?: string;
}

export async function inspectStructLayout(options: {
  goExecutable: string;
  helperPath: string;
  file: string;
  name: string;
  environment: Record<string, string>;
}): Promise<StructLayoutResult> {
  const result = await execFileAsync(
    options.goExecutable,
    [
      'run',
      options.helperPath,
      'struct-layout',
      '-file',
      options.file,
      '-name',
      options.name
    ],
    {
      cwd: path.dirname(options.file),
      env: { ...process.env, ...options.environment },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 2 * 60 * 1000
    }
  );
  const parsed = JSON.parse(result.stdout) as Partial<StructLayoutResult>;
  if (
    typeof parsed.name !== 'string'
    || typeof parsed.size !== 'number'
    || typeof parsed.optimizedSize !== 'number'
    || !Array.isArray(parsed.fields)
    || !Array.isArray(parsed.optimizedFields)
  ) {
    throw new Error('GoTune helper returned an invalid struct layout');
  }
  return parsed as StructLayoutResult;
}
