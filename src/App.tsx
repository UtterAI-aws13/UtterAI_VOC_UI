import { useEffect, useState, useCallback } from 'react';
import { fetchServiceMap, fetchErrorStats } from './api/opensearch';
import type { ServiceMapEdge, ServiceStat } from './api/opensearch';
import ServiceMap from './components/ServiceMap';
import TraceList from './components/TraceList';
import TraceDetail from './components/TraceDetail';
import ErrorStats from './components/ErrorStats';
import styles from './App.module.css';

type Tab = 'map' | 'stats';

export default function App() {
  const [tab, setTab] = useState<Tab>('map');
  const [edges, setEdges] = useState<ServiceMapEdge[]>([]);
  const [stats, setStats] = useState<ServiceStat[]>([]);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null);

  const loadMapData = useCallback(() => {
    fetchServiceMap().then(setEdges).catch(console.error);
    fetchErrorStats(60).then(setStats).catch(console.error);
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
        </nav>
      </header>

      <main className={styles.main}>
        {tab === 'map' && (
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
        )}

        {tab === 'stats' && <ErrorStats />}
      </main>
    </div>
  );
}
