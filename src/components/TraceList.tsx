import { useEffect, useState } from 'react';
import { fetchErrorTraces } from '../api/opensearch';
import type { TraceRow } from '../api/opensearch';
import styles from './TraceList.module.css';

interface Props {
  serviceName: string;
  onSelectTrace: (traceId: string) => void;
}

export default function TraceList({ serviceName, onSelectTrace }: Props) {
  const [traces, setTraces] = useState<TraceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchErrorTraces(serviceName)
      .then(setTraces)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [serviceName]);

  if (loading) return <div className={styles.panel}>로딩 중...</div>;
  if (error) return <div className={styles.panel}>오류: {error}</div>;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.service}>{serviceName}</span>
        <span className={styles.sub}>에러 트레이스 ({traces.length})</span>
      </div>
      {traces.length === 0 ? (
        <div className={styles.empty}>에러 트레이스 없음</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Trace ID</th>
              <th>루트 스팬</th>
              <th>시작 시각</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {traces.map((t) => (
              <tr
                key={t.traceId}
                className={styles.row}
                onClick={() => onSelectTrace(t.traceId)}
              >
                <td className={styles.mono}>{t.traceId.slice(0, 8)}</td>
                <td className={styles.name}>{t.rootName}</td>
                <td className={styles.time}>
                  {new Date(t.startTime).toLocaleTimeString('ko-KR')}
                </td>
                <td className={styles.dur}>{t.durationMs}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
