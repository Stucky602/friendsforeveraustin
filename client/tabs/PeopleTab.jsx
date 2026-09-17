import React, { useEffect, useState } from 'react';
import { api, todayInAustin, addDays, dayLabel } from '../data.js';
import { Button, Empty, ErrorNote, Spinner } from '../ui.jsx';

const GROUPS = ['foodie', 'kids', 'odd'];

export default function PeopleTab({ me, refreshMe }) {
  const [people, setPeople] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [handoff, setHandoff] = useState(null);

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
      await api(`/api/tick/${id}`, { method: mutual.has(id) ? 'DELETE' : 'PUT' });
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
      {handoff ? <Handoff handoff={handoff} onClose={() => setHandoff(null)} /> : null}

      <section className="block">
        <h2>You</h2>
        <div className="selfrow">
          <strong>{self?.display_name}</strong>
          <span className="muted">{(self?.groups ?? []).join(', ') || 'no groups yet'}</span>
          {me.person.visibility === 'public' ? <span className="tag tag-open">open</span> : null}
        </div>
        <div className="btnrow">
          <Button onClick={() => flareFree(todayInAustin())}>Free today</Button>
          <Button onClick={() => flareFree(addDays(todayInAustin(), 4))}>Free {dayLabel(addDays(todayInAustin(), 4))}</Button>
          <Button onClick={setAway}>Add away dates</Button>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={me.person.visibility === 'public'}
            onChange={async (e) => {
              await api('/api/me', { method: 'PUT', body: { visibility: e.target.checked ? 'public' : 'mutual' } });
              await refreshMe();
              await load();
            }}
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

      {me.is_owner ? <AddPerson onAdded={async (r) => { setHandoff(r); await load(); }} onError={setError} /> : null}

      <section className="block">
        <h2>Everyone else</h2>
        <ErrorNote error={error} onRetry={load} />
        {others.length === 0 ? <Empty>Nobody else yet. Add someone above and text them their link.</Empty> : null}
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
                    {p.availability.map((a) => `${a.kind === 'away' ? 'away' : 'free'} ${dayLabel(a.start_date)}`).join(' \u00b7 ')}
                  </span>
                ) : null}
                {me.is_owner ? (
                  <button
                    type="button"
                    className="linkish"
                    onClick={async () => {
                      if (!confirm(`Send ${p.display_name} a new link? Their old one stops working straight away.`)) return;
                      try {
                        const r = await api(`/api/admin/people/${p.id}/regenerate`, { method: 'POST' });
                        setHandoff({ person: p, link: r.link, regenerated: true });
                      } catch (e) { setError(e); }
                    }}
                  >
                    New link
                  </button>
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

function AddPerson({ onAdded, onError }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [groups, setGroups] = useState([]);
  const [busy, setBusy] = useState(false);

  const toggle = (g) => setGroups((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]));

  const add = async () => {
    const display_name = name.trim();
    if (!display_name) return;
    setBusy(true);
    try {
      const r = await api('/api/admin/people', { method: 'POST', body: { display_name, groups } });
      setName('');
      setGroups([]);
      setOpen(false);
      onAdded(r);
    } catch (e) { onError(e); } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <section className="block">
        <h2>Room owner</h2>
        <Button kind="primary" onClick={() => setOpen(true)}>Add someone</Button>
      </section>
    );
  }

  return (
    <section className="block">
      <h2>Add someone</h2>
      <input
        className="field"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Their name"
        autoComplete="off"
      />
      <div className="btnrow">
        {GROUPS.map((g) => (
          <Button key={g} kind={groups.includes(g) ? 'on' : 'default'} onClick={() => toggle(g)}>{g}</Button>
        ))}
      </div>
      <p className="fineprint">Groups are optional. They pick their own on first open.</p>
      <div className="btnrow">
        <Button kind="primary" onClick={add} disabled={busy || !name.trim()}>{busy ? 'Adding' : 'Add and get link'}</Button>
        <Button onClick={() => { setOpen(false); setName(''); setGroups([]); }}>Cancel</Button>
      </div>
    </section>
  );
}

function Handoff({ handoff, onClose }) {
  const [copied, setCopied] = useState(false);
  const { person, link, regenerated } = handoff;
  const message = `Here is your link for Room: ${link}`;

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); } catch { /* the field below is the fallback */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal-scrim" onClick={onClose} />
      <div className="modal-card">
        <header className="modal-head">
          <h2>{person.display_name}</h2>
          <p className="muted">
            {regenerated
              ? 'Their old link stopped working just now. Send them this one.'
              : 'Send them this link. It is the only way in, and this is the only time it is shown.'}
          </p>
        </header>

        <input className="field field-link" value={link} readOnly onFocus={(e) => e.target.select()} />

        <div className="btnrow">
          <Button kind="primary" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</Button>
          <a className="btn btn-default" href={`sms:?&body=${encodeURIComponent(message)}`}>Text it</a>
        </div>

        <p className="fineprint">If you lose it, come back here and tap New link next to their name. That kills the old one.</p>

        <button type="button" className="closer" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
