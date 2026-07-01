import { useCallback, useEffect, useState } from 'react';
import {
  fetchContainers,
  fetchLogs,
  fetchNamespaces,
  fetchPods,
} from '../api/loki';
import type { LogEntry } from '../api/loki';
import styles from './PodLogs.module.css';

export interface DrilldownContext {
  serviceName: string;
  startMs: number;
  endMs: number;
}

// OTel serviceName(OpenSearch) → K8s namespace(Loki) 매핑
// serviceName은 OTEL_SERVICE_NAME 환경변수 값이고,
// Loki 네임스페이스는 실제 K8s namespace 이름이므로 일치하지 않는다.
const SERVICE_TO_NAMESPACE: Record<string, string> = {
  'backend':       'utterai-api',
  'cpu-worker':    'utterai-ai-cpu',
  'ml-gpu-worker': 'utterai-ai-gpu',
  'batch-worker':  'utterai-batch',
};

type Range = '15m' | '1h' | '3h' | '24h';
type Level = 'error' | 'warn' | 'debug' | 'info';

const RANGE_LABELS: Record<Range, string> = {
  '15m': '15분',
  '1h': '1시간',
  '3h': '3시간',
  '24h': '24시간',
};

const LEVEL_COLORS: Record<Level, { ts: string; text: string }> = {
  error: { ts: '#ef5350', text: '#ef9a9a' },
  warn:  { ts: '#ffa726', text: '#ffcc80' },
  debug: { ts: '#37474f', text: '#546e7a' },
  info:  { ts: '#546e7a', text: '#b0bec5' },
};

function detectLevel(line: string): Level {
  const u = line.toUpperCase();
  if (/\b(ERROR|CRITICAL|FATAL|EXCEPTION)\b/.test(u)) return 'error';
  if (/\b(WARN|WARNING)\b/.test(u)) return 'warn';
  if (/\b(DEBUG|TRACE)\b/.test(u)) return 'debug';
  return 'info';
}

function formatTs(tsNs: string): string {
  const ms = parseInt(tsNs.slice(0, 13), 10);
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  const ms3 = d.getMilliseconds().toString().padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms3}`;
}

interface Props {
  drilldown?: DrilldownContext;
  onClearDrilldown?: () => void;
}

export default function PodLogs({ drilldown, onClearDrilldown }: Props) {
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [pods, setPods] = useState<string[]>([]);
  const [containers, setContainers] = useState<string[]>([]);

  const [namespace, setNamespace] = useState('');
  const [pod, setPod] = useState('');
  const [container, setContainer] = useState('');
  const [range, setRange] = useState<Range>('15m');
  const [filter, setFilter] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);

  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchNamespaces()
      .then((ns) => {
        setNamespaces(ns);
        if (ns.length === 0) return;
        if (drilldown) {
          const candidate = SERVICE_TO_NAMESPACE[drilldown.serviceName]
            ?? `utterai-${drilldown.serviceName}`;
          setNamespace(ns.includes(candidate) ? candidate : ns[0]);
        } else {
          setNamespace(ns[0]);
        }
      })
      .catch((e: unknown) => setError(String(e)));
  // drilldown intentionally excluded: only runs on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!namespace) return;
    setPod('');
    setContainers([]);
    setContainer('');
    fetchPods(namespace).then(setPods).catch(console.error);
  }, [namespace]);

  useEffect(() => {
    if (!namespace || !pod) {
      setContainers([]);
      setContainer('');
      return;
    }
    fetchContainers(namespace, pod)
      .then((cs) => { setContainers(cs); setContainer(''); })
      .catch(console.error);
  }, [namespace, pod]);

  const doFetch = useCallback(() => {
    if (!namespace) return;
    setLoading(true);
    setError(null);
    const absoluteRange = drilldown
      ? { startSec: drilldown.startMs / 1000, endSec: drilldown.endMs / 1000 }
      : undefined;
    fetchLogs({ namespace, pod, container, range, absoluteRange })
      .then(setEntries)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [namespace, pod, container, range, drilldown]);

  useEffect(() => {
    const id = setTimeout(doFetch, 200);
    return () => clearTimeout(id);
  }, [doFetch]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(doFetch, 10_000);
    return () => clearInterval(id);
  }, [autoRefresh, doFetch]);

  const displayed = filter
    ? entries.filter((e) => e.line.toLowerCase().includes(filter.toLowerCase()))
    : entries;

  const showPodColumn = !pod;

  return (
    <div className={styles.wrap}>
      {drilldown && (
        <div className={styles.drilldownBanner}>
          <span>
            트레이스 드릴다운 — <strong>{drilldown.serviceName}</strong>
            {' · '}
            {new Date(drilldown.startMs + 60_000).toLocaleTimeString('ko-KR')}
            {' ~ '}
            {new Date(drilldown.endMs - 60_000).toLocaleTimeString('ko-KR')}
          </span>
          {onClearDrilldown && (
            <button className={styles.clearBtn} onClick={onClearDrilldown}>
              해제
            </button>
          )}
        </div>
      )}
      <div className={styles.controls}>
        <select
          className={styles.select}
          value={namespace}
          onChange={(e) => setNamespace(e.target.value)}
        >
          {namespaces.length === 0 && <option value="">네임스페이스 로딩...</option>}
          {namespaces.map((ns) => (
            <option key={ns} value={ns}>{ns}</option>
          ))}
        </select>

        <select
          className={styles.select}
          value={pod}
          onChange={(e) => setPod(e.target.value)}
        >
          <option value="">전체 Pod</option>
          {pods.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>

        <select
          className={styles.select}
          value={container}
          onChange={(e) => setContainer(e.target.value)}
          disabled={!pod}
        >
          <option value="">전체 Container</option>
          {containers.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <select
          className={styles.selectSm}
          value={range}
          onChange={(e) => setRange(e.target.value as Range)}
        >
          {(Object.keys(RANGE_LABELS) as Range[]).map((r) => (
            <option key={r} value={r}>{RANGE_LABELS[r]}</option>
          ))}
        </select>

        <button className={styles.btn} onClick={doFetch}>새로고침</button>

        <label className={styles.autoLabel}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          10s 자동
        </label>

        <input
          className={styles.filterInput}
          placeholder="로그 내용 필터..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        <span className={styles.count}>
          {displayed.length} / {entries.length} 줄
        </span>
      </div>

      <div className={styles.logArea}>
        {loading && entries.length === 0 && (
          <div className={styles.statusMsg}>로딩 중...</div>
        )}
        {error && (
          <div className={`${styles.statusMsg} ${styles.errMsg}`}>오류: {error}</div>
        )}
        {!loading && !error && entries.length === 0 && namespace && (
          <div className={styles.statusMsg}>이 조건에 해당하는 로그가 없습니다</div>
        )}

        {displayed.map((entry, i) => {
          const level = detectLevel(entry.line);
          const colors = LEVEL_COLORS[level];
          return (
            <div key={i} className={styles.line}>
              <span className={styles.ts} style={{ color: colors.ts }}>
                {formatTs(entry.tsNs)}
              </span>
              {showPodColumn && entry.stream.pod && (
                <span className={styles.podTag} title={entry.stream.pod}>
                  {entry.stream.pod}
                </span>
              )}
              <span className={styles.logLine} style={{ color: colors.text }}>
                {entry.line}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
