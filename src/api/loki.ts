const BASE = '/loki';

export interface LogEntry {
  tsNs: string;
  line: string;
  stream: Record<string, string>;
}

async function lokiGet(path: string, params: Record<string, string>) {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== ''))
  ).toString();
  const res = await fetch(`${BASE}${path}${qs ? '?' + qs : ''}`);
  if (!res.ok) throw new Error(`Loki ${res.status}`);
  return res.json();
}

export async function fetchNamespaces(): Promise<string[]> {
  const data = await lokiGet('/api/v1/label/namespace/values', {});
  return ((data.data ?? []) as string[])
    .filter((v) => v.startsWith('utterai-'))
    .sort();
}

export async function fetchPods(namespace: string): Promise<string[]> {
  const data = await lokiGet('/api/v1/label/pod/values', {
    query: `{namespace="${namespace}"}`,
  });
  return ((data.data ?? []) as string[]).sort();
}

export async function fetchContainers(namespace: string, pod: string): Promise<string[]> {
  const data = await lokiGet('/api/v1/label/container/values', {
    query: `{namespace="${namespace}", pod="${pod}"}`,
  });
  return ((data.data ?? []) as string[]).sort();
}

const RANGE_SECONDS: Record<string, number> = {
  '15m': 900,
  '1h': 3_600,
  '3h': 10_800,
  '24h': 86_400,
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function fetchLogs(opts: {
  namespace: string;
  pod: string;
  container: string;
  range: string;
  limit?: number;
  absoluteRange?: { startSec: number; endSec: number };
  userEmail?: string;
}): Promise<LogEntry[]> {
  const { namespace, pod, container, range, limit = 300, absoluteRange, userEmail } = opts;

  const parts = [`namespace="${namespace}"`];
  if (pod) parts.push(`pod="${pod}"`);
  if (container) parts.push(`container="${container}"`);
  const selector = `{${parts.join(', ')}}`;
  const query = userEmail
    ? `${selector} |~ ${JSON.stringify(`(?i)${escapeRegex(userEmail)}`)}`
    : selector;

  let startSec: number, endSec: number;
  if (absoluteRange) {
    startSec = absoluteRange.startSec;
    endSec = absoluteRange.endSec;
  } else {
    const nowSec = Date.now() / 1000;
    startSec = nowSec - (RANGE_SECONDS[range] ?? 900);
    endSec = nowSec;
  }

  const data = await lokiGet('/api/v1/query_range', {
    query,
    start: startSec.toFixed(3),
    end: endSec.toFixed(3),
    limit: String(limit),
    direction: 'backward',
  });

  const entries: LogEntry[] = [];
  for (const stream of (data.data?.result ?? []) as Array<{
    stream: Record<string, string>;
    values: [string, string][];
  }>) {
    for (const [tsNs, line] of stream.values) {
      entries.push({ tsNs, line, stream: stream.stream });
    }
  }

  entries.sort((a, b) => {
    const msA = parseInt(a.tsNs.slice(0, 13), 10);
    const msB = parseInt(b.tsNs.slice(0, 13), 10);
    return msB - msA;
  });

  return entries;
}
