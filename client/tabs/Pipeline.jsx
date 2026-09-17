import React, { useEffect, useState } from 'react';
import { api } from '../data.js';
import { Button, Empty, ErrorNote, Spinner } from '../ui.jsx';

// Owner-only. The pipeline is explicit buttons; the cron just calls the same handlers.
const STAGES = [
  { id: 'discover', label: 'Find events', hint: 'Reads every source, including ltbaustin.com' },
  { id: 'geocode', label: 'Place them', hint: 'Looks up addresses for new venues' },
  { id: 'classify', label: 'Sort them', hint: 'Food, kids, or odd, and the four answers' },
  { id: 'score', label: 'Score them', hint: 'Ranks what is worth showing' },
  { id: 'expire', label: 'Clean up', hint: 'Retires past events and withdrawn listings' },
];

export default function Pipeline() {
  const [status, setStatus] = useState(null);
  const [spend, setSpend] = useState(null);
  const [running, setRunning] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      const [s, m] = await Promise.all([api('/api/run/status'), api('/api/run/spend')]);
      setStatus(s.stages);
      setSpend(m);
    } catch (e) { setError(e); }
  };
  useEffect(() => { load(); }, []);

  const run = async (stage) => {
    setRunning(stage);
    setResult(null);
    setError(null);
    try {
      const r = await api(`/api/run/${stage}?wait=1`, { method: 'POST' });
      setResult({ stage, counts: r.counts });
      await load();
    } catch (e) { setError(e); } finally { setRunning(null); }
  };

  const byStage = new Map((status ?? []).map((s) => [s.stage, s]));

  return (
    <div className="pad">
      <section className="block">
        <h2>Find events</h2>
        <p className="muted">
          Nothing appears until this runs. The cron runs it every six hours; these buttons run it now.
        </p>
        <div className="btnrow">
          <Button kind="primary" onClick={() => run('all')} disabled={!!running}>
            {running === 'all' ? 'Running, this takes a minute' : 'Run everything now'}
          </Button>
        </div>
        <ErrorNote error={error} onRetry={load} />
        {running ? <Spinner label="Working. Scraping is rate limited to one page every three seconds, so be patient." /> : null}
      </section>

      {result ? (
        <section className="block">
          <h2>Last run: {result.stage}</h2>
          <Counts counts={result.counts} />
        </section>
      ) : null}

      <section className="block">
        <h2>Stages</h2>
        {STAGES.map((s) => {
          const st = byStage.get(s.id);
          return (
            <article key={s.id} className="person">
              <div className="person-main">
                <strong>{s.label}</strong>
                <span className="muted">{s.hint}</span>
                {st?.error ? <span className="error">{st.error}</span> : null}
                {st?.last_ok ? <span className="muted">Last ok {new Date(st.last_ok).toLocaleString()}</span> : <span className="muted">Never run</span>}
                {st?.counts && Object.keys(st.counts).length ? <Counts counts={st.counts} /> : null}
              </div>
              <Button onClick={() => run(s.id)} disabled={!!running}>{running === s.id ? 'Running' : 'Run'}</Button>
            </article>
          );
        })}
      </section>

      <Diagnose />

      {spend ? (
        <section className="block">
          <h2>Model spend this month</h2>
          <p className="muted">
            {(spend.used_cents / 100).toFixed(2)} of {(spend.cap_cents / 100).toFixed(2)} dollars. Classifying stops at the cap.
          </p>
        </section>
      ) : null}
    </div>
  );
}

function Diagnose() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="block">
      <h2>What is actually in the database</h2>
      <div className="btnrow">
        <Button onClick={async () => { setBusy(true); try { setData(await api('/api/run/diagnose')); } finally { setBusy(false); } }} disabled={busy}>
          {busy ? 'Checking' : 'Check'}
        </Button>
      </div>
      {data ? <pre className="diag">{JSON.stringify(data, null, 2)}</pre> : null}
    </section>
  );
}

function Counts({ counts }) {
  if (!counts || typeof counts !== 'object') return null;
  const entries = Object.entries(counts).filter(([, v]) => v !== null && v !== undefined);
  if (!entries.length) return <Empty>No numbers reported.</Empty>;
  return (
    <ul className="counts">
      {entries.map(([k, v]) => (
        <li key={k}>
          <span className="counts-k">{k.replace(/_/g, ' ')}</span>
          <span className="counts-v">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
        </li>
      ))}
    </ul>
  );
}
