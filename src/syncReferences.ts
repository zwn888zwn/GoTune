export interface SyncSymbol {
  symbol: string;
  start: number;
  kind: 'channel-send' | 'channel-receive' | 'lock' | 'wait';
}

export function syncSymbolAtLine(line: string): SyncSymbol | undefined {
  const send = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*<-/.exec(line);
  if (send) return symbolResult(send, 1, 'channel-send');

  const receive = /<-\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/.exec(line);
  if (receive) return symbolResult(receive, 1, 'channel-receive');

  const method = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.(Lock|RLock|Unlock|RUnlock|Wait|Done|Add|Signal|Broadcast)\s*\(/.exec(line);
  if (!method) return undefined;
  return symbolResult(
    method,
    1,
    /Lock|Unlock/.test(method[2]) ? 'lock' : 'wait'
  );
}

export function describeSyncUsage(line: string): string {
  const symbol = syncSymbolAtLine(line);
  if (!symbol) return 'reference';
  if (symbol.kind === 'channel-send') return 'channel send';
  if (symbol.kind === 'channel-receive') return 'channel receive';
  if (symbol.kind === 'lock') return 'lock usage';
  return 'coordination usage';
}

function symbolResult(
  match: RegExpExecArray,
  group: number,
  kind: SyncSymbol['kind']
): SyncSymbol {
  const expression = match[group];
  const symbol = expression.split('.').at(-1) ?? expression;
  const expressionStart = match.index + match[0].indexOf(expression);
  return {
    symbol,
    start: expressionStart + expression.lastIndexOf(symbol),
    kind
  };
}
