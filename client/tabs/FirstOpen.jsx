import React, { useState } from 'react';
import { api } from '../data.js';
import { Button, ErrorNote } from '../ui.jsx';

const GROUPS = [
  { id: 'foodie', label: 'Food and drink', hint: 'Places worth eating at' },
  { id: 'kids', label: 'Things with kids', hint: 'Daytime, kid-friendly' },
  { id: 'odd', label: 'Museums and odd screenings', hint: 'Planned a few weeks out' },
];

export default function FirstOpen({ person, onDone }) {
  const [groups, setGroups] = useState(person.groups?.length ? person.groups : []);
  const [open, setOpen] = useState(person.visibility === 'public');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const toggle = (id) => setGroups((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const chosen = groups.length ? groups : ['odd'];
      const { person: updated } = await api('/api/me', {
        method: 'PUT',
        body: { groups: chosen, default_view: chosen[0], visibility: open ? 'public' : 'mutual' },
      });
      onDone(updated);
    } catch (e) {
      setError(e);
      setSaving(false);
    }
  };

  return (
    <div className="firstopen">
      <h1>Hi {person.display_name}</h1>
      <p className="lede">Three taps and you are in.</p>

      <fieldset>
        <legend>What are you up for?</legend>
        {GROUPS.map((g) => (
          <label key={g.id} className={`choice ${groups.includes(g.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={groups.includes(g.id)} onChange={() => toggle(g.id)} />
            <span className="choice-label">{g.label}</span>
            <span className="choice-hint">{g.hint}</span>
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Who can see your side of things?</legend>
        <label className={`choice ${open ? 'on' : ''}`}>
          <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />
          <span className="choice-label">Open to everyone</span>
          <span className="choice-hint">
            Anyone in the room can see your calendar, reviews, and who you are interested in. Being added to
            plans still needs you both to have ticked each other.
          </span>
        </label>
      </fieldset>

      <ErrorNote error={error} />
      <Button kind="primary" onClick={save} disabled={saving}>
        {saving ? 'Saving' : 'Start'}
      </Button>
    </div>
  );
}
