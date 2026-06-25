import { useEffect, useRef } from 'react';
import cytoscape from 'cytoscape';
import type { ServiceMapEdge, ServiceStat } from '../api/opensearch';
import styles from './ServiceMap.module.css';

interface Props {
  edges: ServiceMapEdge[];
  stats: ServiceStat[];
  onNodeClick: (serviceName: string) => void;
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

export default function ServiceMap({ edges, stats, onNodeClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const statMap = Object.fromEntries(stats.map((s) => [s.service, s]));
    const nodeIds = new Set<string>();
    edges.forEach((e) => {
      nodeIds.add(e.source);
      nodeIds.add(e.target);
    });

    const nodes = [...nodeIds].map((id) => {
      const stat = statMap[id];
      const label =
        stat && stat.total > 0
          ? `${id}\n${stat.errorRate.toFixed(1)}% err`
          : id;
      return { data: { id, label, color: nodeColor(stat) } };
    });

    const cyEdges = edges.map((e, i) => ({
      data: {
        id: `e${i}`,
        source: e.source,
        target: e.target,
        label: edgeLabel(e.traceGroupName || e.resource),
      },
    }));

    if (cyRef.current) cyRef.current.destroy();

    cyRef.current = cytoscape({
      container: containerRef.current,
      elements: { nodes, edges: cyEdges },
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            label: 'data(label)',
            color: '#fff',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '11px',
            width: 120,
            height: 52,
            shape: 'roundrectangle',
            'text-wrap': 'wrap',
            'text-max-width': '110px',
          },
        },
        {
          selector: 'edge',
          style: {
            width: 2,
            'line-color': '#90a4ae',
            'target-arrow-color': '#90a4ae',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            label: 'data(label)',
            'font-size': '9px',
            color: '#78909c',
            'text-background-color': '#0d1b2a',
            'text-background-opacity': 1,
            'text-background-padding': '3px',
            'text-wrap': 'wrap',
            'text-max-width': '120px',
          },
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': 3,
            'border-color': '#fff',
          },
        },
      ],
      layout: { name: 'breadthfirst', directed: true, padding: 40, spacingFactor: 1.5 },
      userZoomingEnabled: true,
      userPanningEnabled: true,
    });

    cyRef.current.on('tap', 'node', (evt) => {
      onNodeClick(evt.target.id());
    });

    return () => {
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, [edges, stats, onNodeClick]);

  return <div ref={containerRef} className={styles.canvas} />;
}
