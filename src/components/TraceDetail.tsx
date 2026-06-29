import { useEffect, useState } from 'react';
import { fetchTraceSpans } from '../api/opensearch';
import type { Span } from '../api/opensearch';
import styles from './TraceDetail.module.css';

const SERVICE_COLORS: Record<string, string> = {
  backend: '#2196F3',
  'cpu-worker': '#9C27B0',
  'ml-gpu-worker': '#FF5722',
};

function spanColor(serviceName: string): string {
  return SERVICE_COLORS[serviceName] ?? '#607d8b';
}

export interface ViewLogsInfo {
  serviceName: string;
  startMs: number;
  endMs: number;
}

interface Props {
  traceId: string;
  onBack: () => void;
  onViewLogs?: (info: ViewLogsInfo) => void;
}

export default function TraceDetail({ traceId, onBack, onViewLogs }: Props) {
  const [spans, setSpans] = useState<Span[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Span | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setSelected(null);
    fetchTraceSpans(traceId)
      .then((data) => {
        data.sort(
          (a, b) =>
            new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
        );
        setSpans(data);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [traceId]);

  const t0 = spans.length > 0 ? new Date(spans[0].startTime).getTime() : 0;
  const totalMs =
    spans.length > 0
      ? Math.max(
          ...spans.map(
            (s) =>
              new Date(s.startTime).getTime() +
              (s.durationInNanos ?? 0) / 1_000_000
          )
        ) -
          t0 || 1
      : 1;

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <button className={styles.back} onClick={onBack}>
          ← 뒤로
        </button>
        <span className={styles.traceId}>trace: {traceId}</span>
        {spans.length > 0 && (
          <span className={styles.total}>
            {Math.round(totalMs)}ms · {spans.length}개 스팬
          </span>
        )}
      </div>

      {loading && <div className={styles.msg}>로딩 중...</div>}
      {error && <div className={styles.msg}>오류: {error}</div>}
      {!loading && !error && spans.length === 0 && (
        <div className={styles.msg}>
          스팬을 찾을 수 없습니다 — traceId: {traceId}
        </div>
      )}

      {spans.length > 0 && (
        <>
          <div className={styles.legend}>
            {Object.entries(SERVICE_COLORS).map(([svc, color]) => (
              <span key={svc} className={styles.legendItem}>
                <span className={styles.dot} style={{ background: color }} />
                {svc}
              </span>
            ))}
          </div>

          <div className={styles.ganttWrap}>
            <div className={styles.gantt}>
              {spans.map((span) => {
                const startMs = new Date(span.startTime).getTime() - t0;
                const durMs = (span.durationInNanos ?? 0) / 1_000_000;
                const left = (startMs / totalMs) * 100;
                const width = Math.max((durMs / totalMs) * 100, 0.3);
                const isError = span.status === 'STATUS_CODE_ERROR';

                return (
                  <div
                    key={span.spanId}
                    className={`${styles.spanRow} ${
                      selected?.spanId === span.spanId ? styles.active : ''
                    }`}
                    onClick={() =>
                      setSelected((prev) =>
                        prev?.spanId === span.spanId ? null : span
                      )
                    }
                  >
                    <div className={styles.spanLabel}>
                      <span
                        className={styles.svcTag}
                        style={{ borderColor: spanColor(span.serviceName) }}
                      >
                        {span.serviceName}
                      </span>
                      <span
                        className={`${styles.spanName} ${
                          isError ? styles.errName : ''
                        }`}
                        title={span.name}
                      >
                        {span.name}
                      </span>
                    </div>
                    <div className={styles.bar}>
                      <div
                        className={`${styles.fill} ${isError ? styles.errFill : ''}`}
                        style={{
                          left: `${left}%`,
                          width: `${width}%`,
                          background: isError
                            ? '#f44336'
                            : spanColor(span.serviceName),
                        }}
                        title={`${span.name} — ${Math.round(durMs)}ms`}
                      />
                    </div>
                    <div className={styles.spanDur}>{Math.round(durMs)}ms</div>
                  </div>
                );
              })}
            </div>
          </div>

          {selected && (
            <div className={styles.detail}>
              <div className={styles.detailGrid}>
                <span className={styles.k}>Span ID</span>
                <span className={styles.v}>{selected.spanId}</span>
                <span className={styles.k}>Parent</span>
                <span className={styles.v}>
                  {selected.parentSpanId || '(root)'}
                </span>
                <span className={styles.k}>Service</span>
                <span className={styles.v}>{selected.serviceName}</span>
                <span className={styles.k}>Kind</span>
                <span className={styles.v}>{selected.kind}</span>
                <span className={styles.k}>Status</span>
                <span
                  className={`${styles.v} ${
                    selected.status === 'STATUS_CODE_ERROR' ? styles.errText : ''
                  }`}
                >
                  {selected.status}
                </span>
                <span className={styles.k}>Start</span>
                <span className={styles.v}>{selected.startTime}</span>
                <span className={styles.k}>Duration</span>
                <span className={styles.v}>
                  {Math.round((selected.durationInNanos ?? 0) / 1_000_000)}ms
                </span>
              </div>
              {selected.attributes &&
                Object.keys(selected.attributes).length > 0 && (
                  <pre className={styles.attrs}>
                    {JSON.stringify(selected.attributes, null, 2)}
                  </pre>
                )}
              {onViewLogs && (
                <button
                  className={styles.logsBtn}
                  onClick={() => {
                    const t = new Date(selected.startTime).getTime();
                    const durMs = Math.ceil((selected.durationInNanos ?? 0) / 1_000_000);
                    onViewLogs({ serviceName: selected.serviceName, startMs: t - 60_000, endMs: t + durMs + 60_000 });
                  }}
                >
                  로그 보기 →
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
