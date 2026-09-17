import React from 'react';

export function Button({ children, onClick, kind = 'default', disabled, ...rest }) {
  return (
    <button type="button" className={`btn btn-${kind}`} onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  );
}

export function Empty({ children }) {
  return <p className="empty">{children}</p>;
}

export function Spinner({ label = 'Loading' }) {
  return <p className="empty" role="status">{label}</p>;
}

export function ErrorNote({ error, onRetry }) {
  if (!error) return null;
  return (
    <p className="error" role="alert">
      {error.detail || 'That did not work.'}
      {onRetry ? <button type="button" className="linkish" onClick={onRetry}>Try again</button> : null}
    </p>
  );
}

export function Count({ n, one, many }) {
  return <span className="count">{n} {n === 1 ? one : many}</span>;
}

/** Names of visible people, with the honest shape when the list is partial. */
export function Names({ people, total }) {
  if (!people.length) return total ? <span className="muted">{total} interested</span> : null;
  const names = people.map((p) => p.display_name).join(', ');
  const others = total != null ? total - people.length : 0;
  return <span>{names}{others > 0 ? ` and ${others} more` : ''}</span>;
}
