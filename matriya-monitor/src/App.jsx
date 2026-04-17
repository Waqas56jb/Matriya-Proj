import { useState } from 'react';

const AGENTS = [
  { id: 'CORR-001', name: 'Corrosion Shield', domain: 'Corrosion Protection', es: 0.87, status: 'ACTIVE', metals: ['Steel', 'Aluminum', 'Copper'] },
  { id: 'MAT-002',  name: 'Thermal Barrier',  domain: 'Heat Resistance',      es: 0.74, status: 'ACTIVE', metals: ['Stainless', 'Titanium'] },
  { id: 'ADH-003',  name: 'Adhesion Matrix',  domain: 'Surface Bonding',      es: 0.61, status: 'REVIEW', metals: ['Aluminum', 'Polymer'] },
  { id: 'OXI-004',  name: 'Oxide Sentinel',   domain: 'Oxidation Guard',      es: 0.93, status: 'ACTIVE', metals: ['Copper', 'Iron'] },
];

function esColor(v) {
  if (v >= 0.85) return '#4caf50';
  if (v >= 0.70) return '#ffb300';
  return '#ef5350';
}

function statusBadge(s) {
  return s === 'ACTIVE'
    ? { background: '#1b5e20', color: '#a5d6a7' }
    : { background: '#4a2000', color: '#ffcc80' };
}

export default function App() {
  const [query, setQuery] = useState('');
  const [log, setLog] = useState([]);
  const [running, setRunning] = useState(false);

  function runQuery() {
    const q = query.trim();
    if (!q) return;
    setRunning(true);
    setLog(prev => [{ q, result: null, ts: new Date().toLocaleTimeString() }, ...prev]);
    setTimeout(() => {
      setLog(prev => {
        const updated = [...prev];
        updated[0] = { ...updated[0], result: 'Analysis complete — 0 violations detected. Eₛ stable.' };
        return updated;
      });
      setRunning(false);
    }, 1200);
    setQuery('');
  }

  function handleKey(e) {
    if (e.key === 'Enter') runQuery();
  }

  return (
    <div style={s.root}>
      <header style={s.header}>
        <span style={s.logo}>📡</span>
        <div>
          <div style={s.title}>Matriya Monitor</div>
          <div style={s.subtitle}>Agent Integrity Dashboard</div>
        </div>
        <div style={s.pill}>{AGENTS.filter(a => a.status === 'ACTIVE').length} Active</div>
      </header>

      <div style={s.grid}>
        {AGENTS.map(ag => (
          <div key={ag.id} style={s.card}>
            <div style={s.cardTop}>
              <span style={s.agentId}>{ag.id}</span>
              <span style={{ ...s.badge, ...statusBadge(ag.status) }}>{ag.status}</span>
            </div>
            <div style={s.agentName}>{ag.name}</div>
            <div style={s.domain}>{ag.domain}</div>
            <div style={s.esRow}>
              <span style={s.esLabel}>Eₛ</span>
              <div style={s.esBar}>
                <div style={{ ...s.esFill, width: `${ag.es * 100}%`, background: esColor(ag.es) }} />
              </div>
              <span style={{ ...s.esValue, color: esColor(ag.es) }}>{ag.es.toFixed(2)}</span>
            </div>
            <div style={s.metals}>
              {ag.metals.map(m => <span key={m} style={s.metalTag}>{m}</span>)}
            </div>
          </div>
        ))}
      </div>

      <div style={s.querySection}>
        <div style={s.queryLabel}>Run integrity check</div>
        <div style={s.queryRow}>
          <input
            style={s.input}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="e.g. check CORR-001 galvanic threshold..."
          />
          <button style={{ ...s.runBtn, opacity: running ? 0.6 : 1 }} onClick={runQuery} disabled={running}>
            {running ? '...' : 'Run'}
          </button>
        </div>
        {log.length > 0 && (
          <div style={s.log}>
            {log.slice(0, 4).map((entry, i) => (
              <div key={i} style={s.logEntry}>
                <span style={s.logTs}>{entry.ts}</span>
                <span style={s.logQ}>▶ {entry.q}</span>
                {entry.result && <span style={s.logResult}>✓ {entry.result}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const s = {
  root: {
    minHeight: '100dvh',
    background: '#07090f',
    color: '#e0e0e0',
    fontFamily: "'Segoe UI', Arial, sans-serif",
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    padding: '16px 20px',
    background: '#0d1117',
    borderBottom: '1px solid #1e2535',
  },
  logo: { fontSize: '24px' },
  title: { fontSize: '17px', fontWeight: 700, color: '#4fc3f7' },
  subtitle: { fontSize: '12px', color: '#546e7a', marginTop: '2px' },
  pill: {
    marginLeft: 'auto',
    background: '#0d2a0d',
    color: '#81c784',
    border: '1px solid #2e7d32',
    borderRadius: '20px',
    padding: '4px 12px',
    fontSize: '13px',
    fontWeight: 600,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: '14px',
    padding: '20px 16px',
  },
  card: {
    background: '#0d1117',
    border: '1px solid #1e2535',
    borderRadius: '14px',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  agentId: { fontSize: '11px', color: '#546e7a', fontFamily: 'monospace' },
  badge: { fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '10px' },
  agentName: { fontSize: '16px', fontWeight: 700, color: '#e3f2fd' },
  domain: { fontSize: '12px', color: '#78909c' },
  esRow: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' },
  esLabel: { fontSize: '12px', color: '#90a4ae', width: '18px' },
  esBar: { flex: 1, height: '6px', background: '#1e2535', borderRadius: '4px', overflow: 'hidden' },
  esFill: { height: '100%', borderRadius: '4px', transition: 'width 0.4s' },
  esValue: { fontSize: '13px', fontWeight: 700, width: '36px', textAlign: 'right' },
  metals: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' },
  metalTag: {
    background: '#0d2137',
    color: '#4fc3f7',
    border: '1px solid #1565c0',
    borderRadius: '8px',
    padding: '2px 8px',
    fontSize: '11px',
  },
  querySection: {
    padding: '16px',
    background: '#0d1117',
    borderTop: '1px solid #1e2535',
    marginTop: 'auto',
  },
  queryLabel: { fontSize: '12px', color: '#546e7a', marginBottom: '8px' },
  queryRow: { display: 'flex', gap: '10px' },
  input: {
    flex: 1,
    background: '#07090f',
    border: '1px solid #1e2535',
    borderRadius: '10px',
    color: '#e0e0e0',
    padding: '10px 14px',
    fontSize: '14px',
    outline: 'none',
    fontFamily: 'inherit',
  },
  runBtn: {
    background: '#0d47a1',
    color: '#fff',
    border: 'none',
    borderRadius: '10px',
    padding: '10px 22px',
    fontSize: '14px',
    fontWeight: 700,
    cursor: 'pointer',
  },
  log: {
    marginTop: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  logEntry: {
    background: '#07090f',
    border: '1px solid #1e2535',
    borderRadius: '8px',
    padding: '8px 12px',
    fontSize: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
  },
  logTs: { color: '#37474f' },
  logQ: { color: '#90a4ae' },
  logResult: { color: '#81c784' },
};
