import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { api, cacheGet, cacheSet, getHomeAnchor, setHomeAnchor, todayInAustin, addDays, dayLabel, timeLabel, km, roughMinutes } from '../data.js';
import { Button, Empty, ErrorNote, Spinner, Names } from '../ui.jsx';

const STYLE = 'https://tiles.openfreemap.org/styles/bright';
const AUSTIN = { lng: -97.75, lat: 30.32, zoom: 10.2 };
const VIEWS = [
  { id: 'foodie', label: 'Food' },
  { id: 'kids', label: 'Kids' },
  { id: 'odd', label: 'Odd' },
];

export default function MapTab({ me, view, setView, onOpenPlace, onOpenEvent }) {
  const [date, setDate] = useState(todayInAustin());
  const [night, setNight] = useState(null);
  const [places, setPlaces] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [anchor, setAnchor] = useState(null);
  const [sheet, setSheet] = useState('half');
  const mapRef = useRef(null);
  const containerRef = useRef(null);
  const markersRef = useRef([]);

  useEffect(() => {
    getHomeAnchor().then(setAnchor);
  }, []);

  // map init, once
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE,
      center: [AUSTIN.lng, AUSTIN.lat],
      zoom: AUSTIN.zoom,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');
    let pressTimer = null;
    const startPress = (e) => {
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        const name = prompt('Name of the place');
        if (!name) return;
        const address = prompt('Address, if you know it') || undefined;
        api('/api/places', { method: 'POST', body: { name, address, lat: e.lngLat.lat, lng: e.lngLat.lng } })
          .then(() => load())
          .catch((err) => setError(err));
      }, 600);
    };
    const cancelPress = () => clearTimeout(pressTimer);
    map.on('touchstart', startPress);
    map.on('mousedown', startPress);
    for (const ev of ['touchend', 'touchmove', 'mouseup', 'movestart', 'dragstart']) map.on(ev, cancelPress);
    mapRef.current = map;
    return () => {
      clearTimeout(pressTimer);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [n, p] = await Promise.all([api(`/api/night?date=${date}&view=${view}`), api('/api/places')]);
      setNight(n);
      setPlaces(p.places);
      cacheSet('events', n, `night:${date}:${view}`);
      cacheSet('places', p.places);
    } catch (e) {
      setError(e);
      const [cn, cp] = await Promise.all([cacheGet('events', `night:${date}:${view}`), cacheGet('places')]);
      if (cn) setNight(cn);
      if (cp) setPlaces(cp);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [date, view]);

  // pins: events, vouched places, been-there
  const pins = useMemo(() => {
    const out = [];
    const seen = new Set();
    for (const e of night?.events ?? []) {
      if (!e.place?.lat) continue;
      out.push({ kind: 'event', id: e.id, lat: e.place.lat, lng: e.place.lng, label: timeLabel(e.starts_at), item: e });
      seen.add(e.place.id);
    }
    for (const p of places) {
      if (!p.lat || seen.has(p.id)) continue;
      if (p.vouch_count > 0) out.push({ kind: 'vouch', id: p.id, lat: p.lat, lng: p.lng, label: String(p.vouch_count), item: p });
      else if (p.review_count > 0) out.push({ kind: 'been', id: p.id, lat: p.lat, lng: p.lng, label: '', item: p });
    }
    return out;
  }, [night, places]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const m of markersRef.current) m.remove();
    markersRef.current = pins.map((pin) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `pin pin-${pin.kind}`;
      el.setAttribute('aria-label', pin.item.title || pin.item.name);
      el.textContent = pin.label;
      el.onclick = () => (pin.kind === 'event' ? onOpenEvent(pin.item) : onOpenPlace(pin.item));
      return new maplibregl.Marker({ element: el }).setLngLat([pin.lng, pin.lat]).addTo(map);
    });
  }, [pins]);

  const fallback = useMemo(() => {
    const list = night?.fallback_places ?? [];
    if (!anchor) return list.map((p) => ({ ...p, minutes: null }));
    return list
      .map((p) => ({ ...p, minutes: p.lat ? roughMinutes(km(anchor, p)) : null }))
      .sort((a, b) => (a.minutes ?? 999) - (b.minutes ?? 999));
  }, [night, anchor]);

  const setHome = async () => {
    const map = mapRef.current;
    if (!map) return;
    const c = map.getCenter();
    const a = { lat: c.lat, lng: c.lng };
    await setHomeAnchor(a);
    setAnchor(a);
  };

  const days = [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(todayInAustin(), n));

  return (
    <div className="maptab">
      <div className="map" ref={containerRef} />

      <div className="map-top">
        <div className="viewswitch" role="tablist" aria-label="What to show">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" role="tab" aria-selected={view === v.id} className={view === v.id ? 'on' : ''} onClick={() => setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        <div className="daystrip">
          {days.map((d) => (
            <button key={d} type="button" className={d === date ? 'on' : ''} onClick={() => setDate(d)}>
              {d === todayInAustin() ? 'Today' : dayLabel(d).replace(/,.*/, '')}
              <em>{dayLabel(d).split(' ').slice(1).join(' ')}</em>
            </button>
          ))}
        </div>
      </div>

      <section className={`sheet sheet-${sheet}`} aria-label="What is on">
        <button type="button" className="sheet-grab" onClick={() => setSheet(sheet === 'full' ? 'half' : 'full')} aria-label={sheet === 'full' ? 'Collapse list' : 'Expand list'} />
        <div className="sheet-body">
          <ErrorNote error={error} onRetry={load} />
          {loading && !night ? <Spinner /> : null}

          {night?.plans?.length ? (
            <div className="block">
              <h2>Your plan</h2>
              {night.plans.map((p) => (
                <article key={p.id} className="row row-plan">
                  <div className="row-main">
                    <strong>{p.members.filter((m) => m.state === 'in').length} in</strong>
                    <span className="muted">{p.members.map((m) => m.display_name).join(', ')}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : null}

          <div className="block">
            <h2>Who is around</h2>
            {night ? (
              <p className="who">
                {night.who.free.length ? <><strong>Free:</strong> {night.who.free.map((p) => p.display_name).join(', ')}. </> : null}
                {night.who.around.length ? <>Around: {night.who.around.map((p) => p.display_name).join(', ')}.</> : 'Nobody has said yet.'}
              </p>
            ) : null}
          </div>

          <div className="block">
            <h2>{night?.events?.length ? 'On that night' : 'Nothing on. Places worth it.'}</h2>
            {night?.events?.length
              ? night.events.map((e) => (
                  <article key={e.id} className="row" onClick={() => onOpenEvent(e)}>
                    <time className="row-time">{timeLabel(e.starts_at)}</time>
                    <div className="row-main">
                      <strong>{e.title}</strong>
                      <span className="muted">{e.place?.name}</span>
                      {e.interest_count ? <span className="muted"><Names people={e.interested} total={e.interest_count} /> interested</span> : null}
                    </div>
                  </article>
                ))
              : null}
            {!night?.events?.length && fallback.length
              ? fallback.map((p) => (
                  <article key={p.id} className="row" onClick={() => onOpenPlace(p)}>
                    <span className="row-time">{p.minutes ? `${p.minutes}m` : '·'}</span>
                    <div className="row-main">
                      <strong>{p.name}</strong>
                      {p.vouchers?.length ? <span className="muted">{p.vouchers[0].display_name}: {p.vouchers[0].line}</span> : <span className="muted">{p.vouch_count} vouched</span>}
                    </div>
                  </article>
                ))
              : null}
            {!loading && !night?.events?.length && !fallback.length ? (
              <Empty>Nothing on and nothing vouched yet. Long-press the map to add a place you would stand behind.</Empty>
            ) : null}
            {!anchor && fallback.length ? (
              <Button onClick={setHome}>Set the map centre as home, for drive times</Button>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
