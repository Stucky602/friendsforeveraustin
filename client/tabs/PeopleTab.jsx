import React, { useEffect, useState } from 'react';
import { api, todayInAustin, addDays, dayLabel } from '../data.js';
import { Button, Empty, ErrorNote, Spinner } from '../ui.jsx';

export default function PeopleTab({ me, refreshMe }) {
  const [people, setPeople] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = async () => {
    setError(null);
    try {
      const r = await api('/api/people');
      setPeople(r.people);
    } catch (e) { setError(e); }
  };
  useEffect(() => { load(); }, []);

  const mutual = new Set(me.mutual_ids);
  const toggleTick = async (id) => {
    setBusy(id);
    try {
      await api(`/api/tick/${id}`, { method: mutual.has(id) || me.ticked?.has?.(id) ? 'DELETE' : 'PUT' });
      await refreshMe();
      await load();
    } catch (e) { setError(e); } finally { setBusy(null); }
  };

  const setAway = async () => {
    const start = prompt('Away from (YYYY-MM-DD)', addDays(todayInAustin(), 1));
    if (!start) return;
    const end = prompt('Back on (YYYY-MM-DD)', addDays(start, 3));
    if (!end) return;
    try { await api('/api/availability', { method: 'POST', body: { kind: 'away', start_date: start, end_date: end } }); await load(); }
    catch (e) { setError(e); }
  };

  const flareFree = async (d) => {
    try { await api('/api/availability', { method: 'POST', body: { kind: 'free', start_date: d, end_date: d } }); await load(); }
    catch (e) { setError(e); }
  };

  if (!people) return <div className="pad"><ErrorNote error={error} onRetry={load} />{!error ? <Spinner /> : null}</div>;

  const self = people.find((p) => p.id === me.person.id);
  const others = people.filter((p) => p.id !== me.person.id);

  return (
    <div className="pad">
      <section className="block">
        <h2>You</h2>
        <div className="selfrow">
          <strong>{self?.display_name}</strong>
          <span className="muted">{(self?.groups ?? []).join(', ') || 'no groups yet'}</span>
          {me.person.visibility === 'public' ? <span className="tag tag-open">open</span> : null}
        </div>
        <div className="btnrow">
          <Button onClick={() => flareFree(addDays(todayInAustin(), 0))}>Free today</Button>
          <Button onClick={() => flareFree(addDays(todayInAustin(), 4))}>Free {dayLabel(addDays(todayInAustin(), 4))}</Button>
          <Button onClick={setAway}>Add away dates</Button>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={me.person.visibility === 'public'}
            onChange={async (e) => { await api('/api/me', { method: 'PUT', body: { visibility: e.target.checked ? 'public' : 'mutual' } }); await refreshMe(); await load(); }}
          />
          <span>
            <strong>Open to everyone</strong>
            <em>Anyone in the room can see your calendar, reviews, and who you are interested in. Being added to plans still needs you both to have ticked each other.</em>
          </span>
        </label>
        {self?.availability?.length ? (
          <ul className="dates">
            {self.availability.map((a) => (
              <li key={a.id}>
                <span className={`tag tag-${a.kind}`}>{a.kind === 'away' ? 'away' : 'free'}</span>
                {dayLabel(a.start_date)}{a.end_date !== a.start_date ? ` to ${dayLabel(a.end_date)}` : ''}
                <button type="button" className="linkish" onClick={async () => { await api(`/api/availability/${a.id}`, { method: 'DELETE' }); await load(); }}>Remove</button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="block">
        <h2>Everyone else</h2>
        <ErrorNote error={error} onRetry={load} />
        {others.length === 0 ? <Empty>Nobody else yet. The room owner sends out the links.</Empty> : null}
        {others.map((p) => {
          const isMutual = mutual.has(p.id);
          const canSee = 'groups' in p;
          return (
            <article key={p.id} className="person">
              <div className="person-main">
                <strong>{p.display_name}</strong>
                {p.visibility === 'public' ? <span className="tag tag-open">open</span> : null}
                {canSee ? <span className="muted">{(p.groups ?? []).join(', ') || 'no groups yet'}</span> : <span className="muted">Tick to compare plans</span>}
                {canSee && p.availability?.length ? (
                  <span className="muted">
                    {p.availability.map((a) => `${a.kind === 'away' ? 'away' : 'free'} ${dayLabel(a.start_date)}`).join(' · ')}
                  </span>
                ) : null}
              </div>
              <Button kind={isMutual ? 'on' : 'default'} onClick={() => toggleTick(p.id)} disabled={busy === p.id}>
                {isMutual ? 'Ticked' : 'Tick'}
              </Button>
            </article>
          );
        })}
        <p className="fineprint">Ticking is private. Nobody is told who ticked them, and there is nothing to accept or decline.</p>
      </section>
    </div>
  );
}
