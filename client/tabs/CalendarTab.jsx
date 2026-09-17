import React, { useEffect, useMemo, useState } from 'react';
import { api, todayInAustin, addDays, dayLabel, timeLabel } from '../data.js';
import { Button, Empty, ErrorNote, Spinner } from '../ui.jsx';

const WEEK = 7;

export default function CalendarTab({ me, onOpenEvent }) {
  const [start, setStart] = useState(todayInAustin());
  const [days, setDays] = useState(null);
  const [error, setError] = useState(null);

  const dates = useMemo(() => Array.from({ length: WEEK * 2 }, (_, i) => addDays(start, i)), [start]);

  const load = async () => {
    setError(null);
    try {
      const out = {};
      for (const d of dates) out[d] = await api(`/api/night?date=${d}&view=${me.person.default_view}`);
      setDays(out);
    } catch (e) { setError(e); }
  };
  useEffect(() => { load(); }, [start]);

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

  return (
    <div className="pad">
      <div className="btnrow">
        <Button onClick={() => setStart(addDays(start, -WEEK))}>Back a week</Button>
        <Button onClick={() => setStart(todayInAustin())}>Today</Button>
        <Button onClick={() => setStart(addDays(start, WEEK))}>Forward a week</Button>
      </div>
      <ErrorNote error={error} onRetry={load} />
      {!days ? <Spinner /> : null}
      {days
        ? dates.map((d) => {
            const n = days[d];
            const busy = (n?.events?.length ?? 0) + (n?.plans?.length ?? 0);
            return (
              <section key={d} className={`day ${d === todayInAustin() ? 'day-today' : ''}`}>
                <h2>
                  {dayLabel(d)}
                  {n?.who?.free?.length ? <span className="muted">{n.who.free.map((p) => p.display_name).join(', ')} free</span> : null}
                </h2>
                {n?.plans?.map((p) => (
                  <div key={p.id} className="row row-plan">
                    <time className="row-time">{timeLabel(p.starts_at)}</time>
                    <div className="row-main"><strong>Your plan</strong><span className="muted">{p.members.filter((m) => m.state === 'in').length} in</span></div>
                  </div>
                ))}
                {n?.events?.slice(0, 4).map((e) => (
                  <div key={e.id} className="row" onClick={() => onOpenEvent(e)}>
                    <time className="row-time">{timeLabel(e.starts_at)}</time>
                    <div className="row-main"><strong>{e.title}</strong><span className="muted">{e.place?.name}</span></div>
                  </div>
                ))}
                {!busy ? <p className="day-quiet">Quiet</p> : null}
              </section>
            );
          })
        : null}
      <div className="btnrow">
        <Button onClick={ics}>Download what I am in for (.ics)</Button>
      </div>
      <p className="fineprint">A download, not a subscription. Re-download when your plans change.</p>
    </div>
  );
}
