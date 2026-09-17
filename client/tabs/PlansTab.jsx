import React, { useEffect, useState } from 'react';
import { api, timeLabel, dayLabel } from '../data.js';
import { Button, Empty, ErrorNote, Spinner } from '../ui.jsx';

const dateOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
  .formatToParts(new Date(iso)).reduce((a, p) => (p.type === 'literal' ? a : { ...a, [p.type]: p.value }), {});

export default function PlansTab({ me }) {
  const [plans, setPlans] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null);

  const load = async () => {
    setError(null);
    try { const r = await api('/api/plans'); setPlans(r.plans); } catch (e) { setError(e); }
  };
  useEffect(() => { load(); }, []);

  const setState = async (id, state) => {
    try { await api(`/api/plans/${id}/me`, { method: 'PUT', body: { state } }); await load(); } catch (e) { setError(e); }
  };

  const copy = async (id) => {
    try {
      const text = await api(`/api/plans/${id}/text`, { raw: true });
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch (e) { setError(e); }
  };

  if (!plans) return <div className="pad"><ErrorNote error={error} onRetry={load} />{!error ? <Spinner /> : null}</div>;

  const open = plans.filter((p) => p.status === 'open');
  const past = plans.filter((p) => p.status === 'done');

  return (
    <div className="pad">
      <ErrorNote error={error} onRetry={load} />
      <section className="block">
        <h2>Coming up</h2>
        {open.length === 0 ? <Empty>No plans yet. Open something on the map and start one.</Empty> : null}
        {open.map((p) => {
          const mine = p.members.find((m) => m.person_id === me.person.id);
          const d = dateOf(p.starts_at);
          return (
            <article key={p.id} className="plan">
              <header>
                <time className="plan-when">{dayLabel(`${d.year}-${d.month}-${d.day}`)}, {timeLabel(p.starts_at)}</time>
                <span className="muted">{p.members.filter((m) => m.state === 'in').length} in</span>
              </header>
              <ul className="members">
                {p.members.map((m) => (
                  <li key={m.person_id} className={`state-${m.state}`}>
                    {m.display_name}
                    <em>{m.state === 'out' ? 'can\u2019t make it' : m.state}</em>
                  </li>
                ))}
              </ul>
              <div className="btnrow">
                <Button kind={mine?.state === 'in' ? 'on' : 'primary'} onClick={() => setState(p.id, 'in')} disabled={mine?.state === 'in'}>I&rsquo;m in</Button>
                <Button onClick={() => setState(p.id, 'out')} disabled={mine?.state === 'out'}>Can&rsquo;t make it</Button>
                <Button onClick={() => copy(p.id)}>{copied === p.id ? 'Copied' : 'Copy'}</Button>
              </div>
            </article>
          );
        })}
      </section>

      {past.length ? (
        <section className="block">
          <h2>Went</h2>
          {past.map((p) => {
            const d = dateOf(p.starts_at);
            return (
              <article key={p.id} className="plan plan-past">
                <header>
                  <time className="plan-when">{dayLabel(`${d.year}-${d.month}-${d.day}`)}</time>
                  <span className="muted">{p.members.filter((m) => m.state === 'went').map((m) => m.display_name).join(', ')}</span>
                </header>
              </article>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}
