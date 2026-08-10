import { useEffect, useState } from 'react';
import { api } from '../api';
import type { FsListing } from '../types';

/**
 * A small modal directory picker. Navigates the server's filesystem via /api/fs
 * (browsers can't read disk) and returns the chosen directory path.
 */
export function DirectoryBrowser({
  start,
  onPick,
  onClose,
}: {
  start: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [error, setError] = useState('');

  const load = (path?: string) => {
    setError('');
    api
      .fs(path)
      .then(setListing)
      .catch((e) => setError(String(e)));
  };

  useEffect(() => {
    load(start || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal browser" onClick={(e) => e.stopPropagation()}>
        <h2>Choose a working directory</h2>

        <div className="browser-roots">
          {listing?.roots.map((r) => (
            <button key={r} className="chip" onClick={() => load(r)}>
              {r}
            </button>
          ))}
        </div>

        <div className="browser-path mono">
          {listing?.parent && (
            <button className="btn up" onClick={() => load(listing.parent!)} title="Up one level">
              ⬆
            </button>
          )}
          <span className="cur">{listing?.path || '…'}</span>
        </div>

        {error && <div className="error-box">{error}</div>}

        <div className="browser-list">
          {listing?.entries.length === 0 && <div className="muted pad">No sub-folders here.</div>}
          {listing?.entries.map((e) => (
            <button
              key={e.path}
              className={`browser-entry ${e.isDir ? 'dir' : 'file'}`}
              onClick={() => e.isDir && load(e.path)}
              disabled={!e.isDir}
            >
              <span className="glyph">{e.isDir ? '📁' : '📄'}</span>
              <span className="name">{e.name}</span>
            </button>
          ))}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!listing} onClick={() => listing && onPick(listing.path)}>
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}
