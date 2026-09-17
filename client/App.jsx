import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';

// MapLibre is most of the bundle. The three non-map tabs should not pay for it on a phone.
const MapTab = lazy(() => import('./tabs/MapTab.jsx'));
import CalendarTab from './tabs/CalendarTab.jsx';
import PeopleTab from './tabs/PeopleTab.jsx';
import PlansTab from './tabs/PlansTab.jsx';
import FirstOpen from './tabs/FirstOpen.jsx';
import { api, claimTokenFromUrl, getToken, timeLabel, watchVersion, reloadForNewVersion } from './data.js';
import { Button, Empty, ErrorNote, Spinner, Names } from './ui.jsx';

const TABS = [
  { id: 'map', label: 'Map' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'people', label: 'People' },
  { id: 'plans', label: 'Plans' },
];

export default function App() {
  const [me, setMe] = useState(null);
  const [status, setStatus] = useState('loading');
  const [tab, setTab] = useState('map');
  const [view, setView] = useState('odd');
  const [detail, setDetail] = useState(null);
  const [stale, setStale] = useState(false);

  const refreshMe = useCallback(async () => {
    const r = await api('/api/me');
    setMe({ ...r, mutual_ids: r.mutual_ids ?? [] });
    return r;
  }, []);

  useEffect(() => {
    claimTokenFromUrl();
    if (!getToken()) {
      setStatus('nolink');
      return;
    }
    refreshMe()
      .then((r) => { setView(r.person.default_view); setStatus('ready'); })
      .catch((e) => setStatus(e.code === 'token' ? 'badlink' : 'error'));
  }, [refreshMe]);

  useEffect(() => {
    if (!me?.version) return;
    return watchVersion(me.version, () => setStale(true));
  }, [me?.version]);

  if (status === 'loading') return <div className="pad"><Spinner /></div>;
  if (status === 'nolink' || status === 'badlink')
    return (
      <div className="pad firstopen">
        <h1>Room</h1>
        <p className="lede">
          {status === 'nolink'
            ? 'This app runs on a personal link. Ask whoever runs the room to send you yours.'
            : 'That link no longer works. Ask the room owner for a new one.'}
        </p>
      </div>
    );
  if (status === 'error') return <div className="pad"><ErrorNote error={{ detail: 'Could not reach the room.' }} onRetry={() => location.reload()} /></div>;

  const needsFirstOpen = !me.person.groups?.length;
  if (needsFirstOpen)
    return (
      <div className="pad">
        <FirstOpen person={me.person} onDone={(person) => { setView(person.default_view); setMe({ ...me, person }); }} />
      </div>
    );

  return (
    <div className="app" data-view={view}>
      {stale ? (
        <button type="button" className="stalebar" onClick={reloadForNewVersion}>
          A newer version is ready. Tap to load it.
        </button>
      ) : null}

      <main className="main">
        {tab === 'map' ? (
          <Suspense fallback={<div className="pad"><Spinner label="Loading the map" /></div>}>
            <MapTab me={me} view={view} setView={setView} onOpenPlace={(p) => setDetail({ kind: 'place', item: p })} onOpenEvent={(e) => setDetail({ kind: 'event', item: e })} />
          </Suspense>
        ) : null}
        {tab === 'calendar' ? <CalendarTab me={me} onOpenEvent={(e) => setDetail({ kind: 'event', item: e })} /> : null}
        {tab === 'people' ? <PeopleTab me={me} refreshMe={refreshMe} /> : null}
        {tab === 'plans' ? <PlansTab me={me} /> : null}
      </main>

      <nav className="tabbar" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={tab === t.id ? 'on' : ''} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {detail ? <Detail me={me} detail={detail} onClose={() => setDetail(null)} onPlanned={() => { setDetail(null); setTab('plans'); }} /> : null}
    </div>
  );
}

function Detail({ me, detail, onClose, onPlanned }) {
  const isEvent = detail.kind === 'event';
  const [place, setPlace] = useState(isEvent ? null : detail.item);
  const [error, setError] = useState(null);
  const [interested, setInterested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState(null);
  const [text, setText] = useState('');

  const placeId = isEvent ? detail.item.place?.id : detail.item.id;

  const loadPlace = useCallback(async () => {
    if (!placeId) return;
    try { const r = await api(`/api/places/${placeId}`); setPlace(r.place); } catch (e) { setError(e); }
  }, [placeId]);
  useEffect(() => { loadPlace(); }, [loadPlace]);

  useEffect(() => {
    const list = isEvent ? detail.item.interested : detail.item.interested ?? [];
    setInterested((list ?? []).some((p) => p.person_id === me.person.id));
  }, [detail, me.person.id, isEvent]);

  const toggleInterest = async () => {
    setBusy(true);
    try {
      await api(`/api/interest/${isEvent ? 'event' : 'place'}/${detail.item.id}`, { method: interested ? 'DELETE' : 'PUT' });
      setInterested(!interested);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const startPlan = async () => {
    setBusy(true);
    try {
      await api('/api/plans', {
        method: 'POST',
        body: {
          target_type: isEvent ? 'event' : 'place',
          target_id: detail.item.id,
          starts_at: isEvent ? detail.item.starts_at : new Date(Date.now() + 86400e3).toISOString(),
          member_ids: me.mutual_ids,
        },
      });
      onPlanned();
    } catch (e) { setError(e); setBusy(false); }
  };

  const vouch = async () => {
    const line = prompt('One sentence. Why would you send someone here?');
    if (!line) return;
    try { await api(`/api/vouch/${placeId}`, { method: 'PUT', body: { line } }); await loadPlace(); } catch (e) { setError(e); }
  };

  const review = async () => {
    if (!verdict) return;
    try {
      await api(`/api/places/${placeId}/reviews`, { method: 'POST', body: { verdict, text } });
      setVerdict(null); setText('');
      await loadPlace();
      const r = await api(`/api/places/${placeId}/vouch-prompt`, { method: 'POST' });
      if (r.offer) vouch();
    } catch (e) { setError(e); }
  };

  const answers = isEvent ? detail.item.answers ?? {} : {};
  const labels = Object.entries(answers)
    .filter(([, a]) => a.value !== 'unknown' && a.confidence >= 0.6)
    .map(([k, a]) => (k === 'cost' ? a.value : k === 'parking' ? `${a.value} parking` : k === 'loud' ? a.value : `kids ${a.value}`));

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal-scrim" onClick={onClose} />
      <div className="modal-card">
        <header className="modal-head">
          <div>
            <h2>{isEvent ? detail.item.title : detail.item.name}</h2>
            <p className="muted">
              {isEvent ? <>{timeLabel(detail.item.starts_at)} · {detail.item.place?.name}</> : detail.item.address}
            </p>
          </div>
        </header>

        <ErrorNote error={error} />

        {labels.length ? <p className="answers">{labels.join(' · ')}</p> : null}

        {isEvent && detail.item.interest_count ? (
          <p className="muted"><Names people={detail.item.interested} total={detail.item.interest_count} /> interested</p>
        ) : null}

        <div className="btnrow">
          <Button kind={interested ? 'on' : 'primary'} onClick={toggleInterest} disabled={busy}>
            {interested ? 'Interested' : 'I\u2019d go'}
          </Button>
          <Button onClick={startPlan} disabled={busy}>Start a plan</Button>
          {isEvent && detail.item.sources?.[0]?.url ? (
            <a className="btn btn-default" href={detail.item.sources[0].url} target="_blank" rel="noreferrer">Listing</a>
          ) : null}
        </div>

        {place ? (
          <section className="block">
            <h3>{place.name}</h3>
            <p className="muted">
              {place.vouch_count} vouched · {place.verdicts.loved} loved, {place.verdicts.fine} fine, {place.verdicts.bounced} bounced
            </p>
            {place.vouchers?.map((v) => (
              <p key={v.person_id} className="vouch"><strong>{v.display_name}</strong> {v.line}</p>
            ))}
            {place.reviews?.length ? (
              <ul className="reviews">
                {place.reviews.map((r) => (
                  <li key={r.id}>
                    <span className={`tag tag-${r.verdict}`}>{r.verdict}</span>
                    <strong>{r.display_name}</strong>
                    {r.text ? <span>{r.text}</span> : null}
                  </li>
                ))}
              </ul>
            ) : <Empty>No reviews from anyone you can see.</Empty>}

            <div className="reviewform">
              <div className="btnrow">
                {['loved', 'fine', 'bounced'].map((v) => (
                  <Button key={v} kind={verdict === v ? 'on' : 'default'} onClick={() => setVerdict(v)}>{v}</Button>
                ))}
              </div>
              {verdict ? (
                <>
                  <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="What happened? Optional." rows={3} />
                  <Button kind="primary" onClick={review}>Save review</Button>
                </>
              ) : null}
              <Button onClick={vouch}>Vouch for this place</Button>
            </div>
          </section>
        ) : null}

        <button type="button" className="closer" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
