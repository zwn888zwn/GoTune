export interface LaunchConfigurationLike {
  name?: string;
  buildFlags?: string | string[];
  [key: string]: unknown;
}

export function withProfilerBuildFlags<T extends LaunchConfigurationLike>(
  configuration: T,
  extraFlags: string[]
): T {
  const current = configuration.buildFlags;
  const buildFlags = Array.isArray(current)
    ? [...current, ...extraFlags]
    : [typeof current === 'string' ? current.trim() : '', ...extraFlags]
      .filter(Boolean)
      .join(' ');
  return { ...configuration, buildFlags };
}

export function launchTargetIdentity(workspaceFolder: string, configurationName: string): string {
  return `launch:${workspaceFolder}:${configurationName}`;
}
