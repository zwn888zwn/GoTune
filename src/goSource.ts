export function isMainGoSource(text: string): boolean {
  let source = text.replace(/^\uFEFF/, '');
  while (true) {
    source = source.trimStart();
    if (source.startsWith('//')) {
      const newline = source.indexOf('\n');
      source = newline < 0 ? '' : source.slice(newline + 1);
      continue;
    }
    if (source.startsWith('/*')) {
      const end = source.indexOf('*/', 2);
      if (end < 0) return false;
      source = source.slice(end + 2);
      continue;
    }
    break;
  }
  return /^package\s+main\b/.test(source);
}

export function parseMainPackageOutput(output: string): { importPath: string; directory: string } | undefined {
  const [importPath, directory] = output.trim().split('\t', 2);
  return importPath && directory ? { importPath, directory } : undefined;
}
