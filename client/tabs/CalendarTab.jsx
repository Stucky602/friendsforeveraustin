import React, { useEffect, useMemo, useState } from 'react';
import { api, todayInAustin, dayLabel, timeLabel } from '../data.js';
import { Button, Empty, ErrorNote, Spinner } from '../ui.jsx';

const RANGES = [
  { days: 14, label: '2 weeks' },
  { days: 45, label: '6 weeks' },
  { days: 120, label: '4 months' },
];
const GROUPS = [
  { id: 'all', label: 'All' },
  { id: 'foodie', label: 'Food' },
  { id: 'kids', label: 'Kids' },
  { id: 'odd', label: 'Odd' },
];

const chicagoDay = (iso) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(iso))
    .filter((p) => p.type !== 'literal')
    .reduce((a, p) => ({ ...a, [p.type]: p.value }), {});

const dayKey = (iso) => {
  const d = chicagoDay(iso);
  return `${d.year}-${d.month}-${d.day}`;
};

export default function CalendarTab({ me, onOpenEvent }) {
  const [view, setView] = useState('all');
  const [days, setDays] = useState(45);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // One request for the whole range. This used to be one request per day, fourteen deep.
  const load = async () => {
    setLoading(true);
    setError(null);
    try { setData(await api(`/api/upcoming?view=${view}&days=${days}`)); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [view, days]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const p of data?.plans ?? []) {
      const k = dayKey(p.starts_at);
      if (!map.has(k)) map.set(k, { plans: [], events: [] });
      map.get(k).plans.push(p);
    }
    for (const e of data?.events ?? []) {
      const k = dayKey(e.starts_at);
      if (!map.has(k)) map.set(k, { plans: [], events: [] });
      map.get(k).events.push(e);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [data]);

  const ics = async () => {
    try {
      const text = await api('/api/calendar.ics', { raw: true });
      const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'room.ics';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e); }
  };

  const today = todayInAustin();

  return (
    <div className="pad">
      <div className="viewswitch viewswitch-inline" role="tablist" aria-label="What to show">
        {GROUPS.map((g) => (
          <button key={g.id} type="button" role="tab" aria-selected={view === g.id} className={view === g.id ? 'on' : ''} onClick={() => setView(g.id)}>
            {g.label}
          </button>
        ))}
      </div>
      <div className="btnrow">
        {RANGES.map((r) => (
          <Button key={r.days} kind={days === r.days ? 'on' : 'default'} onClick={() => setDays(r.days)}>{r.label}</Button>
        ))}
      </div>

      <ErrorNote error={error} onRetry={load} />
      {loading && !data ? <Spinner /> : null}
      {data && !grouped.length ? (
        <Empty>Nothing in the next {days} days. Run the pipeline from the Sources tab if this seems wrong.</Empty>
      ) : null}

      {grouped.map(([d, { plans, events }]) => (
        <section key={d} className={`day ${d === today ? 'day-today' : ''}`}>
          <h2>
            {dayLabel(d)}
            <span className="muted">{events.length + plans.length}</span>
          </h2>
          {plans.map((p) => (
            <div key={p.id} className="row row-plan">
              <time className="row-time">{timeLabel(p.starts_at)}</time>
              <div className="row-main">
                <strong>Your plan</strong>
                <span className="muted">{p.members.filter((m) => m.state === 'in').length} in</span>
              </div>
            </div>
          ))}
          {events.map((e) => (
            <div key={e.id} className="row" onClick={() => onOpenEvent(e)}>
              <time className="row-time">{timeLabel(e.starts_at)}</time>
              <div className="row-main">
                <strong>{e.title}</strong>
                <span className="muted">
                  {e.place?.name}
                  {e.groups?.length ? ` \u00b7 ${e.groups.join(', ')}` : ''}
                  {e.interest_count ? ` \u00b7 ${e.interest_count} interested` : ''}
                </span>
              </div>
            </div>
          ))}
        </section>
      ))}

      <div className="btnrow">
        <Button onClick={ics}>Download what I am in for (.ics)</Button>
      </div>
      <p className="fineprint">A download, not a subscription. Re-download when your plans change.</p>
    </div>
  );
}
