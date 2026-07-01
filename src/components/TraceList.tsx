import { useEffect, useRef, useState } from 'react';
import { fetchRecentTraces } from '../api/opensearch';
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
  const [jobIdInput, setJobIdInput] = useState('');
  const [activeJobId, setActiveJobId] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setActiveJobId('');
    setJobIdInput('');
    fetchRecentTraces(serviceName)
      .then(setTraces)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [serviceName]);

  const handleSearch = () => {
    const trimmed = jobIdInput.trim();
    if (!trimmed) {
      setActiveJobId('');
      setLoading(true);
      fetchRecentTraces(serviceName)
        .then(setTraces)
        .catch((e) => setError(String(e)))
        .finally(() => setLoading(false));
      return;
    }
    setActiveJobId(trimmed);
    setLoading(true);
    setError(null);
    fetchRecentTraces(serviceName, 20, trimmed)
      .then(setTraces)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  const errorCount = traces.filter((t) => t.hasError).length;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.service}>{serviceName}</span>
        <span className={styles.sub}>
          {activeJobId ? `job_id 검색: ${traces.length}건` : `최근 ${traces.length}건`}
          {errorCount > 0 && (
            <span className={styles.errorBadge}> 에러 {errorCount}</span>
          )}
        </span>
      </div>

      <div className={styles.searchRow}>
        <input
          ref={inputRef}
          className={styles.searchInput}
          placeholder="job_id로 검색..."
          value={jobIdInput}
          onChange={(e) => setJobIdInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <button className={styles.searchBtn} onClick={handleSearch}>
          검색
        </button>
        {activeJobId && (
          <button
            className={styles.clearBtn}
            onClick={() => {
              setJobIdInput('');
              setActiveJobId('');
              setLoading(true);
              fetchRecentTraces(serviceName)
                .then(setTraces)
                .catch((e) => setError(String(e)))
                .finally(() => setLoading(false));
            }}
          >
            ✕
          </button>
        )}
      </div>

      {loading && <div className={styles.empty}>로딩 중...</div>}
      {error && <div className={styles.empty} style={{ color: '#ef9a9a' }}>오류: {error}</div>}
      {!loading && !error && traces.length === 0 ? (
        <div className={styles.empty}>
          {activeJobId ? `job_id "${activeJobId}" 결과 없음` : '수신된 트레이스 없음'}
        </div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Trace ID</th>
              <th>진입점</th>
              <th>시작 시각</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {traces.map((t) => (
              <tr
                key={t.traceId}
                className={`${styles.row} ${t.hasError ? styles.errorRow : ''}`}
                onClick={() => onSelectTrace(t.traceId)}
              >
                <td className={styles.mono}>{t.traceId.slice(0, 8)}</td>
                <td className={styles.name}>
                  {t.hasError && <span className={styles.errDot} title="ERROR" />}
                  {t.rootName}
                </td>
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
