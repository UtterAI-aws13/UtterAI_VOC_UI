import { useEffect, useState, useCallback } from 'react';
import { fetchErrorStats } from '../api/opensearch';
import type { ServiceStat } from '../api/opensearch';
import styles from './ErrorStats.module.css';

const RANGES = [
  { label: '15m', value: 15 },
  { label: '1h', value: 60 },
  { label: '6h', value: 360 },
  { label: '24h', value: 1440 },
];

export default function ErrorStats() {
  const [range, setRange] = useState(60);
  const [stats, setStats] = useState<ServiceStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchErrorStats(range)
      .then((data) => {
        setStats(data);
        setLastUpdated(new Date());
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [range]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <span className={styles.title}>에러 통계</span>
        <div className={styles.rangeGroup}>
          {RANGES.map((r) => (
            <button
              key={r.value}
              className={`${styles.rangeBtn} ${range === r.value ? styles.active : ''}`}
              onClick={() => setRange(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button className={styles.refreshBtn} onClick={load}>
          새로고침
        </button>
        {lastUpdated && (
          <span className={styles.updated}>
            {lastUpdated.toLocaleTimeString('ko-KR')} 기준
          </span>
        )}
      </div>

      {loading ? (
        <div className={styles.loading}>로딩 중...</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>서비스</th>
              <th>총 요청</th>
              <th>에러</th>
              <th>에러율</th>
              <th>p50 (ms)</th>
              <th>p99 (ms)</th>
            </tr>
          </thead>
          <tbody>
            {stats.length === 0 ? (
              <tr>
                <td colSpan={6} className={styles.empty}>
                  데이터 없음
                </td>
              </tr>
            ) : (
              stats.map((s) => (
                <tr key={s.service}>
                  <td className={styles.svc}>{s.service}</td>
                  <td>{s.total.toLocaleString()}</td>
                  <td>{s.errors.toLocaleString()}</td>
                  <td>
                    <span
                      className={styles.rate}
                      style={{
                        color:
                          s.errorRate > 10
                            ? '#f44336'
                            : s.errorRate > 0
                            ? '#FF9800'
                            : '#4CAF50',
                      }}
                    >
                      {s.errorRate.toFixed(1)}%
                    </span>
                  </td>
                  <td>{s.p50Ms}</td>
                  <td>{s.p99Ms}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
