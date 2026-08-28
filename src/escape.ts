import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { Hotspot, ProfileSession } from './model';
import { applySourcePathMappings } from './sourcePath';

const execFileAsync = promisify(execFile);
const compilerLine = /^(.*?\.go):(\d+):(\d+):\s+(.*)$/;

export async function analyzeEscapes(
  hotspot: Hotspot | undefined,
  session: ProfileSession | undefined,
  diagnostics: vscode.DiagnosticCollection,
  goExecutable: string,
  environment: Record<string, string>,
  buildFlags: string[] = []
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const file = hotspot?.location?.file ?? editor?.document.uri.fsPath;
  if (!file) {
    void vscode.window.showInformationMessage('GoTune: Select a hotspot with source information first.');
    return;
  }
  const resolvedFile = await resolveSourceFile(file);
  if (!resolvedFile) {
    void vscode.window.showWarningMessage(`GoTune: Could not locate ${file} in this workspace.`);
    return;
  }
  const requestedLine = hotspot?.location?.line
    ?? (editor && path.resolve(editor.document.uri.fsPath) === path.resolve(resolvedFile.fsPath)
      ? editor.selection.active.line + 1
      : 1);
  const functionRange = await findFunctionRange(resolvedFile, requestedLine);
  const buildTags = vscode.workspace
    .getConfiguration('go', resolvedFile)
    .get<string>('buildTags', '')
    .trim();
  const effectiveBuildFlags = buildTags && !hasTagsFlag(buildFlags)
    ? [...buildFlags, `-tags=${buildTags}`]
    : buildFlags;

  const cwd = path.dirname(resolvedFile.fsPath);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'GoTune: analyzing escapes', cancellable: false },
    async () => {
      try {
        const result = await execFileAsync(
          goExecutable,
          ['build', ...effectiveBuildFlags, '-gcflags=-m=2', '-o', os.devNull, '.'],
          {
            cwd,
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, ...environment }
          }
        );
        publishDiagnostics(
          `${result.stdout}\n${result.stderr}`,
          cwd,
          resolvedFile.fsPath,
          hotspot,
          session,
          functionRange,
          diagnostics
        );
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; message?: string; code?: string };
        const output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
        const count = publishDiagnostics(
          output,
          cwd,
          resolvedFile.fsPath,
          hotspot,
          session,
          functionRange,
          diagnostics
        );
        if (count === 0) {
          const hint = failure.code === 'ENOENT'
            ? `找不到 Go 可执行文件“${goExecutable}”，请检查 VS Code Go 设置。`
            : summarizeBuildFailure(output)
              ?? '逃逸分析失败，请检查当前 package 的构建配置。';
          void vscode.window.showErrorMessage(`GoTune: ${hint}`);
        }
      }
    }
  );
}

function hasTagsFlag(buildFlags: string[]): boolean {
  return buildFlags.some((flag) => flag === '-tags' || flag.startsWith('-tags='));
}

function summarizeBuildFailure(output: string): string | undefined {
  const errors = output
    .split(/\r?\n/)
    .map((line) => compilerLine.exec(line.trim()))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .filter((match) => !/(escapes to heap|moved to heap|captur|leaking param|heap)/i.test(match[4]));
  if (errors.length === 0) return undefined;
  const first = errors[0];
  const additional = errors.length > 1 ? `，另有 ${errors.length - 1} 个编译错误` : '';
  return `当前 package 无法编译：${path.basename(first[1])}:${first[2]}:${first[3]} ${first[4]}${additional}。请先修复错误，或确认 go.buildTags 配置正确。`;
}

function publishDiagnostics(
  output: string,
  cwd: string,
  targetFile: string,
  hotspot: Hotspot | undefined,
  session: ProfileSession | undefined,
  functionRange: vscode.Range | undefined,
  collection: vscode.DiagnosticCollection
): number {
  collection.clear();
  const grouped = new Map<string, vscode.Diagnostic[]>();
  for (const rawLine of output.split(/\r?\n/)) {
    const match = compilerLine.exec(rawLine.trim());
    if (!match) continue;
    const message = match[4];
    if (!/(escapes to heap|moved to heap|leaking param|heap)/i.test(message)) continue;
    const filename = path.resolve(cwd, match[1]);
    if (path.resolve(filename) !== path.resolve(targetFile)) continue;
    const line = Math.max(0, Number(match[2]) - 1);
    if (functionRange && (line < functionRange.start.line || line > functionRange.end.line)) continue;
    const column = Math.max(0, Number(match[3]) - 1);
    const evidence = hotspot && session?.sampleType.startsWith('alloc_')
      ? ` · Profile evidence: ${formatProfileValue(hotspot.cumulative, session.sampleUnit)} cumulative`
      : '';
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(line, column, line, column + 1),
      `${message}${evidence}`,
      vscode.DiagnosticSeverity.Information
    );
    diagnostic.source = 'GoTune escape analysis';
    grouped.set(filename, [...(grouped.get(filename) ?? []), diagnostic]);
  }
  for (const [filename, entries] of grouped) {
    collection.set(vscode.Uri.file(filename), entries);
  }
  const count = [...grouped.values()].reduce((sum, entries) => sum + entries.length, 0);
  const target = hotspot?.name ?? (functionRange ? 'current function' : path.basename(targetFile));
  const summary = count === 0
    ? `GoTune: ${target} has no compiler-reported escapes.`
    : `GoTune: found ${count} escape result${count === 1 ? '' : 's'} in ${target}.`;
  void vscode.window.showInformationMessage(summary);
  return count;
}

async function findFunctionRange(uri: vscode.Uri, requestedLine: number): Promise<vscode.Range | undefined> {
  const document = await vscode.workspace.openTextDocument(uri);
  const targetLine = Math.max(0, Math.min(document.lineCount - 1, requestedLine - 1));
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider',
    uri
  );
  const candidates: vscode.DocumentSymbol[] = [];
  const visit = (items: vscode.DocumentSymbol[]): void => {
    for (const item of items) {
      if (item.kind === vscode.SymbolKind.Function || item.kind === vscode.SymbolKind.Method) {
        candidates.push(item);
      }
      visit(item.children);
    }
  };
  visit(symbols ?? []);
  const position = new vscode.Position(targetLine, 0);
  const symbol = candidates
    .filter((candidate) => candidate.range.contains(position))
    .sort((left, right) => rangeSize(left.range) - rangeSize(right.range))[0];
  if (symbol) return symbol.range;

  for (let start = targetLine; start >= 0; start--) {
    if (!/^\s*func\b/.test(document.lineAt(start).text)) continue;
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
        return targetLine <= end
          ? new vscode.Range(start, 0, end, document.lineAt(end).text.length)
          : undefined;
      }
    }
  }
  return undefined;
}

function rangeSize(range: vscode.Range): number {
  return (range.end.line - range.start.line) * 100_000 + range.end.character - range.start.character;
}

function formatProfileValue(value: number, unit: string): string {
  if (unit === 'nanoseconds') {
    if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)} s`;
    if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)} ms`;
    if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(2)} µs`;
    return `${value.toFixed(0)} ns`;
  }
  if (unit === 'bytes') {
    if (Math.abs(value) >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
    if (Math.abs(value) >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MiB`;
    if (Math.abs(value) >= 1024) return `${(value / 1024).toFixed(2)} KiB`;
    return `${value.toFixed(0)} B`;
  }
  return new Intl.NumberFormat().format(value);
}

export async function resolveSourceFile(filename: string): Promise<vscode.Uri | undefined> {
  const mappings = vscode.workspace
    .getConfiguration('gotune')
    .get<Record<string, string>>('sourcePathMappings', {});
  const mappedFilename = applySourcePathMappings(filename, mappings);
  const direct = vscode.Uri.file(mappedFilename);
  try {
    await vscode.workspace.fs.stat(direct);
    return direct;
  } catch {
    const normalized = mappedFilename.replaceAll('\\', '/');
    const parts = normalized.split('/');
    for (let length = Math.min(5, parts.length); length >= 1; length--) {
      const suffix = parts.slice(-length).join('/');
      const matches = await vscode.workspace.findFiles(`**/${suffix}`, '**/{vendor,node_modules}/**', 2);
      if (matches.length === 1) return matches[0];
    }
    return undefined;
  }
}
