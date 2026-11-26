import { ConnectionError, ConnectionErrorReason } from './errors';

function endpointKey(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['https:', 'wss:', 'http:', 'ws:'].includes(url.protocol)) return undefined;
    return url.href.replace(/^http/, 'ws').replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

/** The issuer's ranked nodes, excluding the node already being attempted. */
export class FallbackUrlProvider {
  readonly urls: string[] = [];
  private index = 0;

  constructor(currentUrl: string, candidates: string[]) {
    const current = endpointKey(currentUrl);
    const seen = new Set([current]);
    for (const candidate of candidates) {
      const key = endpointKey(candidate);
      if (!key || seen.has(key) || (current?.startsWith('wss:') && key.startsWith('ws:'))) continue;
      seen.add(key);
      this.urls.push(candidate);
    }
  }

  getNextUrl(): string | undefined {
    return this.urls[this.index++];
  }

  resetAttempts() {
    this.index = 0;
  }
}

export function isTerminalConnectionError(error: unknown): boolean {
  return (
    error instanceof ConnectionError &&
    (error.reason === ConnectionErrorReason.NotAllowed ||
      error.reason === ConnectionErrorReason.Cancelled ||
      error.status === 401 ||
      error.status === 403)
  );
}

export function isEndpointUnavailable(error: unknown): boolean {
  if (!(error instanceof ConnectionError) || isTerminalConnectionError(error)) return false;
  // A successful validation response after a failed upgrade also means signaling is unreachable.
  return (
    error.reason === ConnectionErrorReason.ServerUnreachable ||
    (error.reason === ConnectionErrorReason.InternalError &&
      error.status !== undefined &&
      (error.status === 200 || error.status >= 500))
  );
}
