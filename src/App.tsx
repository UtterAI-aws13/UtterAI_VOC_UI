import { useEffect, useState, useCallback } from 'react';
import { fetchServiceMap, fetchErrorStats } from './api/opensearch';
import type { ServiceMapEdge, ServiceStat } from './api/opensearch';
import ServiceMap from './components/ServiceMap';
import TraceList from './components/TraceList';
import TraceDetail from './components/TraceDetail';
import ErrorStats from './components/ErrorStats';
import PodLogs from './components/PodLogs';
import type { DrilldownContext } from './components/PodLogs';
import styles from './App.module.css';

type Tab = 'map' | 'stats' | 'logs';

function healthColor(stat: ServiceStat) {
  if (stat.errorRate > 10) return '#f44336';
  if (stat.errorRate > 0) return '#FF9800';
  return '#4CAF50';
}

export default function App() {
  const [tab, setTab] = useState<Tab>('map');
  const [edges, setEdges] = useState<ServiceMapEdge[]>([]);
  const [stats, setStats] = useState<ServiceStat[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null);
  const [drilldown, setDrilldown] = useState<DrilldownContext | null>(null);

  const loadMapData = useCallback(() => {
    Promise.all([
      fetchServiceMap(),
      fetchErrorStats(60),
    ]).then(([e, s]) => {
      setEdges(e);
      setStats(s);
      setLastUpdated(new Date());
    }).catch(console.error);
  }, []);

  useEffect(() => {
    loadMapData();
  }, [loadMapData]);

  if (selectedTrace) {
    return (
      <div className={styles.full}>
        <TraceDetail
          traceId={selectedTrace}
          onBack={() => setSelectedTrace(null)}
          onViewLogs={(info) => {
            setDrilldown(info);
            setTab('logs');
            setSelectedTrace(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <span className={styles.logo}>UtterAI VOC</span>
        <nav className={styles.tabs}>
          <button
            className={`${styles.tab} ${tab === 'map' ? styles.activeTab : ''}`}
            onClick={() => setTab('map')}
          >
            Service Map
          </button>
          <button
            className={`${styles.tab} ${tab === 'stats' ? styles.activeTab : ''}`}
            onClick={() => setTab('stats')}
          >
            에러 통계
          </button>
          <button
            className={`${styles.tab} ${tab === 'logs' ? styles.activeTab : ''}`}
            onClick={() => { setTab('logs'); setDrilldown(null); }}
          >
            Pod Logs
          </button>
        </nav>
        <div className={styles.headerRight}>
          {lastUpdated && (
            <span className={styles.updatedAt}>
              {lastUpdated.toLocaleTimeString('ko-KR')} 기준
            </span>
          )}
          <button className={styles.refreshBtn} onClick={loadMapData} title="새로고침">
            ↺
          </button>
        </div>
      </header>

      <main className={styles.main}>
        {tab === 'map' && (
          <>
            {stats.length > 0 && (
              <div className={styles.healthBar}>
                {stats.map((s) => (
                  <div
                    key={s.service}
                    className={styles.healthCard}
                    style={{ borderLeftColor: healthColor(s) }}
                    onClick={() => setSelectedService(s.service)}
                  >
                    <span className={styles.healthName}>{s.service}</span>
                    <span className={styles.healthMetrics}>
                      <span className={styles.healthReq}>{s.total} req</span>
                      <span
                        className={styles.healthErr}
                        style={{ color: healthColor(s) }}
                      >
                        {s.errorRate.toFixed(1)}% err
                      </span>
                      <span className={styles.healthLat}>p99 {s.p99Ms}ms</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className={styles.mapLayout}>
              <div className={styles.mapArea}>
                <ServiceMap
                  edges={edges}
                  stats={stats}
                  onNodeClick={(svc) => setSelectedService(svc)}
                />
              </div>
              {selectedService && (
                <div className={styles.listPanel}>
                  <TraceList
                    serviceName={selectedService}
                    onSelectTrace={(id) => setSelectedTrace(id)}
                  />
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'stats' && <ErrorStats />}
        {tab === 'logs' && (
          <PodLogs
            drilldown={drilldown ?? undefined}
            onClearDrilldown={() => setDrilldown(null)}
          />
        )}
      </main>
    </div>
  );
}
