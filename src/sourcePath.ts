export function applySourcePathMappings(
  filename: string,
  mappings: Record<string, string>
): string {
  const normalized = normalize(filename);
  const match = Object.entries(mappings)
    .map(([remote, local]) => [normalize(remote).replace(/\/+$/, ''), normalize(local)] as const)
    .filter(([remote]) => normalized === remote || normalized.startsWith(`${remote}/`))
    .sort(([left], [right]) => right.length - left.length)[0];
  if (!match) return filename;
  const [remote, local] = match;
  return `${local.replace(/\/+$/, '')}${normalized.slice(remote.length)}`;
}

export function sourcePathsMatch(
  left: string | undefined,
  right: string | undefined,
  mappings: Record<string, string> = {}
): boolean {
  if (!left || !right) return false;
  const a = normalize(applySourcePathMappings(left, mappings));
  const b = normalize(applySourcePathMappings(right, mappings));
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function normalize(value: string): string {
  return value.replaceAll('\\', '/');
}
