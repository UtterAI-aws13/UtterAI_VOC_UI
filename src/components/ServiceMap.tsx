import { useEffect, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import type { ServiceMapEdge, ServiceStat } from '../api/opensearch';
import styles from './ServiceMap.module.css';

interface Props {
  edges: ServiceMapEdge[];
  stats: ServiceStat[];
  onNodeClick: (serviceName: string) => void;
}

interface Tooltip {
  x: number;
  y: number;
  id: string;
  stat: ServiceStat;
}

function edgeLabel(raw: string): string {
  const clean = raw.replace(/\{[^}]+\}/g, '*').replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/, '');
  const parts = clean.split('/').filter(Boolean);
  return parts[parts.length - 1] || raw;
}

function nodeColor(stat: ServiceStat | undefined): string {
  if (!stat || stat.total === 0) return '#4CAF50';
  if (stat.errorRate > 10) return '#f44336';
  if (stat.errorRate > 0) return '#FF9800';
  return '#4CAF50';
}

function nodeLabel(id: string, stat: ServiceStat | undefined): string {
  if (!stat || stat.total === 0) return `${id}\n— req  —% err\np99: —`;
  return `${id}\n${stat.total} req  ${stat.errorRate.toFixed(1)}% err\np99: ${stat.p99Ms}ms`;
}

export default function ServiceMap({ edges, stats, onNodeClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const statMap = Object.fromEntries(stats.map((s) => [s.service, s]));
    const maxTraffic = Math.max(...stats.map((s) => s.total), 1);

    const nodeIds = new Set<string>();
    edges.forEach((e) => { nodeIds.add(e.source); nodeIds.add(e.target); });
    stats.forEach((s) => nodeIds.add(s.service));

    const nodes = [...nodeIds].map((id) => {
      const stat = statMap[id];
      return {
        data: {
          id,
          label: nodeLabel(id, stat),
          borderColor: nodeColor(stat),
        },
      };
    });

    // Deduplicate edges (same source→target pair)
    const seen = new Set<string>();
    const cyEdges = edges
      .filter((e) => {
        const key = `${e.source}→${e.target}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((e, i) => {
        const srcStat = statMap[e.source];
        const w = srcStat ? Math.max((srcStat.total / maxTraffic) * 4 + 1, 1) : 1.5;
        return {
          data: {
            id: `e${i}`,
            source: e.source,
            target: e.target,
            label: edgeLabel(e.traceGroupName || e.resource),
            width: w,
          },
        };
      });

    if (cyRef.current) cyRef.current.destroy();

    cyRef.current = cytoscape({
      container: containerRef.current,
      elements: { nodes, edges: cyEdges },
      style: [
        {
          selector: 'node',
          style: {
            'background-color': '#131f2e',
            'border-color': 'data(borderColor)',
            'border-width': 3,
            label: 'data(label)',
            color: '#cfd8dc',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '11px',
            'font-family': "'Inter', system-ui, sans-serif",
            width: 160,
            height: 72,
            shape: 'roundrectangle',
            'text-wrap': 'wrap',
            'text-max-width': '148px',
            'text-line-height': 1.5,
          },
        },
        {
          selector: 'node:selected',
          style: {
            'background-color': '#1a2e42',
            'border-width': 3,
            'border-color': '#64b5f6',
          },
        },
        {
          selector: 'node:active',
          style: { 'overlay-opacity': 0 },
        },
        {
          selector: 'edge',
          style: {
            width: 'data(width)',
            'line-color': '#37474f',
            'target-arrow-color': '#546e7a',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            label: 'data(label)',
            'font-size': '9px',
            color: '#546e7a',
            'text-background-color': '#0d1b2a',
            'text-background-opacity': 1,
            'text-background-padding': '2px',
          },
        },
        {
          selector: 'edge:selected',
          style: { 'line-color': '#90a4ae', 'target-arrow-color': '#90a4ae' },
        },
      ],
      layout: {
        name: 'breadthfirst',
        directed: true,
        padding: 60,
        spacingFactor: 1.8,
      },
      userZoomingEnabled: true,
      userPanningEnabled: true,
    });

    cyRef.current.on('tap', 'node', (evt) => {
      onNodeClick(evt.target.id());
    });

    cyRef.current.on('mouseover', 'node', (evt) => {
      const id = evt.target.id() as string;
      const stat = statMap[id];
      if (!stat || !containerRef.current) return;
      const pos = evt.target.renderedPosition() as { x: number; y: number };
      const rect = containerRef.current.getBoundingClientRect();
      setTooltip({ x: rect.left + pos.x + 20, y: rect.top + pos.y - 20, id, stat });
    });

    cyRef.current.on('mouseout', 'node', () => setTooltip(null));

    return () => {
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, [edges, stats, onNodeClick]);

  return (
    <div className={styles.wrap}>
      <div ref={containerRef} className={styles.canvas} />

      {tooltip && (
        <div
          className={styles.tooltip}
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className={styles.ttHeader}>{tooltip.id}</div>
          <div className={styles.ttRow}>
            <span className={styles.ttKey}>Requests</span>
            <span className={styles.ttVal}>{tooltip.stat.total.toLocaleString()}</span>
          </div>
          <div className={styles.ttRow}>
            <span className={styles.ttKey}>Error rate</span>
            <span
              className={styles.ttVal}
              style={{
                color:
                  tooltip.stat.errorRate > 10
                    ? '#f44336'
                    : tooltip.stat.errorRate > 0
                    ? '#FF9800'
                    : '#4CAF50',
              }}
            >
              {tooltip.stat.errorRate.toFixed(1)}%
            </span>
            <div className={styles.ttBar}>
              <div
                className={styles.ttFill}
                style={{
                  width: `${Math.min(tooltip.stat.errorRate, 100)}%`,
                  background:
                    tooltip.stat.errorRate > 10
                      ? '#f44336'
                      : tooltip.stat.errorRate > 0
                      ? '#FF9800'
                      : '#4CAF50',
                }}
              />
            </div>
          </div>
          <div className={styles.ttDivider} />
          <div className={styles.ttRow}>
            <span className={styles.ttKey}>p50</span>
            <span className={styles.ttVal}>{tooltip.stat.p50Ms}ms</span>
          </div>
          <div className={styles.ttRow}>
            <span className={styles.ttKey}>p99</span>
            <span className={styles.ttVal}>{tooltip.stat.p99Ms}ms</span>
          </div>
          <div className={styles.ttDivider} />
          <div className={styles.ttHint}>클릭하여 트레이스 조회</div>
        </div>
      )}
    </div>
  );
}
