export function buildProfileUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl);
  if (!endpoint || /\/debug\/pprof\/[^/]+\/?$/.test(url.pathname)) {
    return url.toString();
  }
  const [endpointPath, endpointQuery] = endpoint.split('?', 2);
  const search = new URLSearchParams(url.search);
  if (endpointQuery) {
    for (const [key, value] of new URLSearchParams(endpointQuery)) {
      search.set(key, value);
    }
  }
  const trimmedPath = url.pathname.replace(/\/+$/, '');
  url.pathname = trimmedPath.endsWith('/debug/pprof')
    ? `${trimmedPath}/${endpointPath}`
    : `${trimmedPath}/debug/pprof/${endpointPath}`;
  url.search = search.toString();
  return url.toString();
}
