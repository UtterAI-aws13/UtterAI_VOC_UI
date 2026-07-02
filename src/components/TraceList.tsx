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
  const [searchInput, setSearchInput] = useState('');
  const [searchMode, setSearchMode] = useState<'job_id' | 'user.email'>('job_id');
  const [activeSearch, setActiveSearch] = useState<{ mode: 'job_id' | 'user.email'; value: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setActiveSearch(null);
    setSearchInput('');
    fetchRecentTraces(serviceName)
      .then(setTraces)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [serviceName]);

  const doFetch = (mode: 'job_id' | 'user.email', value: string) => {
    setLoading(true);
    setError(null);
    const jobId = mode === 'job_id' ? value : undefined;
    const userEmail = mode === 'user.email' ? value : undefined;
    fetchRecentTraces(serviceName, 20, jobId, userEmail)
      .then(setTraces)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  const handleSearch = () => {
    const trimmed = searchInput.trim();
    if (!trimmed) {
      setActiveSearch(null);
      setLoading(true);
      fetchRecentTraces(serviceName)
        .then(setTraces)
        .catch((e) => setError(String(e)))
        .finally(() => setLoading(false));
      return;
    }
    setActiveSearch({ mode: searchMode, value: trimmed });
    doFetch(searchMode, trimmed);
  };

  const errorCount = traces.filter((t) => t.hasError).length;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.service}>{serviceName}</span>
        <span className={styles.sub}>
          {activeSearch
            ? `${activeSearch.mode} 검색: ${traces.length}건`
            : `최근 ${traces.length}건`}
          {errorCount > 0 && (
            <span className={styles.errorBadge}> 에러 {errorCount}</span>
          )}
        </span>
      </div>

      <div className={styles.searchRow}>
        <select
          className={styles.modeSelect}
          value={searchMode}
          onChange={(e) => setSearchMode(e.target.value as 'job_id' | 'user.email')}
        >
          <option value="job_id">job_id</option>
          <option value="user.email">user.email</option>
        </select>
        <input
          ref={inputRef}
          className={styles.searchInput}
          placeholder={searchMode === 'job_id' ? 'job_id 입력...' : '이메일 입력...'}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <button className={styles.searchBtn} onClick={handleSearch}>
          검색
        </button>
        {activeSearch && (
          <button
            className={styles.clearBtn}
            onClick={() => {
              setSearchInput('');
              setActiveSearch(null);
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
          {activeSearch
            ? `${activeSearch.mode} "${activeSearch.value}" 결과 없음`
            : '수신된 트레이스 없음'}
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
                  {new Date(t.startTime).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })}
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
