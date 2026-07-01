const BASE = '/opensearch';

export interface ServiceMapEdge {
  source: string;
  target: string;
  resource: string;
  traceGroupName: string;
}

export interface TraceRow {
  traceId: string;
  rootName: string;
  startTime: string;
  durationMs: number;
  hasError?: boolean;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  serviceName: string;
  name: string;
  kind: string;
  status: string;
  startTime: string;
  durationInNanos: number;
  attributes?: Record<string, unknown>;
}

export interface ServiceStat {
  service: string;
  total: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p99Ms: number;
}

async function query(index: string, body: unknown) {
  const res = await fetch(`${BASE}/${index}/_search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenSearch error: ${res.status}`);
  return res.json();
}

export async function fetchServiceMap(): Promise<ServiceMapEdge[]> {
  const data = await query('otel-v1-apm-service-map', {
    size: 200,
    query: { match_all: {} },
    _source: ['serviceName', 'destination', 'target', 'traceGroupName'],
  });

  const edges: ServiceMapEdge[] = [];
  for (const hit of data.hits.hits) {
    const s = hit._source;
    if (s.destination?.domain) {
      edges.push({
        source: s.serviceName,
        target: s.destination.domain,
        resource: s.destination.resource ?? '',
        traceGroupName: s.traceGroupName ?? '',
      });
    }
  }
  return edges;
}

export async function fetchRecentTraces(
  serviceName: string,
  limit = 20,
  jobId?: string,
  userEmail?: string,
): Promise<TraceRow[]> {
  const esQuery = jobId
    ? { term: { 'attributes.job\\.id': jobId } }
    : userEmail
    ? { term: { 'attributes.user\\.email': userEmail } }
    : {
        bool: {
          must: [
            { term: { serviceName } },
            {
              bool: {
                should: [
                  { term: { kind: 'SPAN_KIND_SERVER' } },
                  { term: { kind: 'SPAN_KIND_CONSUMER' } },
                ],
                minimum_should_match: 1,
              },
            },
          ],
        },
      };

  const data = await query('otel-v1-apm-span-*', {
    size: limit,
    query: esQuery,
    sort: [{ startTime: { order: 'desc' } }],
    _source: ['traceId', 'name', 'startTime', 'durationInNanos', 'status'],
  });

  return data.hits.hits.map((h: { _source: Record<string, unknown> }) => {
    const s = h._source as {
      traceId: string;
      name: string;
      startTime: string;
      durationInNanos?: number;
      status?: string;
    };
    return {
      traceId: s.traceId,
      rootName: s.name,
      startTime: s.startTime,
      durationMs: Math.round((s.durationInNanos ?? 0) / 1_000_000),
      hasError: s.status === 'STATUS_CODE_ERROR',
    };
  });
}

export async function fetchTraceSpans(traceId: string): Promise<Span[]> {
  const data = await query('otel-v1-apm-span-*', {
    size: 500,
    query: { term: { traceId } },
    _source: [
      'traceId', 'spanId', 'parentSpanId', 'serviceName',
      'name', 'kind', 'status', 'startTime', 'durationInNanos', 'attributes',
    ],
    sort: [{ startTime: { order: 'asc' } }],
  });
  return data.hits.hits.map((h: { _source: Span }) => h._source);
}

export async function fetchErrorStats(
  rangeMinutes: number
): Promise<ServiceStat[]> {
  const data = await query('otel-v1-apm-span-*', {
    size: 0,
    query: {
      bool: {
        must: [
          {
            bool: {
              should: [
                { term: { kind: 'SPAN_KIND_SERVER' } },
                { term: { kind: 'SPAN_KIND_CONSUMER' } },
              ],
              minimum_should_match: 1,
            },
          },
          { range: { startTime: { gte: `now-${rangeMinutes}m` } } },
        ],
      },
    },
    aggs: {
      by_service: {
        terms: { field: 'serviceName.keyword', size: 20 },
        aggs: {
          error_count: { filter: { term: { status: 'STATUS_CODE_ERROR' } } },
          p50: { percentiles: { field: 'durationInNanos', percents: [50] } },
          p99: { percentiles: { field: 'durationInNanos', percents: [99] } },
        },
      },
    },
  });

  return (data.aggregations?.by_service?.buckets ?? []).map(
    (b: {
      key: string;
      doc_count: number;
      error_count: { doc_count: number };
      p50: { values: { '50.0': number } };
      p99: { values: { '99.0': number } };
    }) => ({
      service: b.key,
      total: b.doc_count,
      errors: b.error_count.doc_count,
      errorRate:
        b.doc_count > 0
          ? Math.round((b.error_count.doc_count / b.doc_count) * 1000) / 10
          : 0,
      p50Ms: Math.round((b.p50.values['50.0'] ?? 0) / 1_000_000),
      p99Ms: Math.round((b.p99.values['99.0'] ?? 0) / 1_000_000),
    })
  );
}
