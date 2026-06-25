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

interface Props {
  traceId: string;
  onBack: () => void;
}

export default function TraceDetail({ traceId, onBack }: Props) {
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

  if (loading) return <div className={styles.wrap}>로딩 중...</div>;
  if (error) return <div className={styles.wrap}>오류: {error}</div>;
  if (spans.length === 0) return <div className={styles.wrap}>스팬 없음</div>;

  const t0 = new Date(spans[0].startTime).getTime();
  const ends = spans.map(
    (s) =>
      new Date(s.startTime).getTime() + (s.durationInNanos ?? 0) / 1_000_000
  );
  const totalMs = Math.max(...ends) - t0 || 1;

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <button className={styles.back} onClick={onBack}>
          ← 뒤로
        </button>
        <span className={styles.traceId}>trace: {traceId.slice(0, 16)}…</span>
        <span className={styles.total}>{Math.round(totalMs)}ms · {spans.length}개 스팬</span>
      </div>

      <div className={styles.legend}>
        {Object.entries(SERVICE_COLORS).map(([svc, color]) => (
          <span key={svc} className={styles.legendItem}>
            <span className={styles.dot} style={{ background: color }} />
            {svc}
          </span>
        ))}
      </div>

      <div className={styles.gantt}>
        {spans.map((span) => {
          const startMs =
            new Date(span.startTime).getTime() - t0;
          const durMs = (span.durationInNanos ?? 0) / 1_000_000;
          const left = (startMs / totalMs) * 100;
          const width = Math.max((durMs / totalMs) * 100, 0.3);
          const isError = span.status === 'STATUS_CODE_ERROR';

          return (
            <div
              key={span.spanId}
              className={`${styles.spanRow} ${selected?.spanId === span.spanId ? styles.active : ''}`}
              onClick={() => setSelected(span)}
            >
              <div className={styles.spanLabel}>
                <span className={styles.svcTag} style={{ borderColor: spanColor(span.serviceName) }}>
                  {span.serviceName}
                </span>
                <span className={`${styles.spanName} ${isError ? styles.errName : ''}`}>
                  {span.name}
                </span>
              </div>
              <div className={styles.bar}>
                <div
                  className={`${styles.fill} ${isError ? styles.errFill : ''}`}
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    background: isError ? '#f44336' : spanColor(span.serviceName),
                  }}
                  title={`${span.name} — ${Math.round(durMs)}ms`}
                />
              </div>
              <div className={styles.spanDur}>{Math.round(durMs)}ms</div>
            </div>
          );
        })}
      </div>

      {selected && (
        <div className={styles.detail}>
          <div className={styles.detailGrid}>
            <span className={styles.k}>Span ID</span>
            <span className={styles.v}>{selected.spanId}</span>
            <span className={styles.k}>Parent</span>
            <span className={styles.v}>{selected.parentSpanId || '(root)'}</span>
            <span className={styles.k}>Service</span>
            <span className={styles.v}>{selected.serviceName}</span>
            <span className={styles.k}>Kind</span>
            <span className={styles.v}>{selected.kind}</span>
            <span className={styles.k}>Status</span>
            <span className={`${styles.v} ${selected.status === 'STATUS_CODE_ERROR' ? styles.errText : ''}`}>
              {selected.status}
            </span>
            <span className={styles.k}>Start</span>
            <span className={styles.v}>{selected.startTime}</span>
            <span className={styles.k}>Duration</span>
            <span className={styles.v}>
              {Math.round((selected.durationInNanos ?? 0) / 1_000_000)}ms
            </span>
          </div>
          {selected.attributes && Object.keys(selected.attributes).length > 0 && (
            <pre className={styles.attrs}>
              {JSON.stringify(selected.attributes, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
