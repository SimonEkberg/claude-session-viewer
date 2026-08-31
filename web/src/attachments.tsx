import { useCallback, useState } from 'react';
import type { PromptImage } from './types';

/**
 * Prompt image attachments (paste / drop / file-pick) shared by the New-session and
 * follow-up composers. Images are held as base64 and sent to the server, which feeds
 * them to the `claude` CLI as native image content blocks (via --input-format
 * stream-json) — the same thing pasting a screenshot into the Claude Code TUI does.
 */
export interface AttachedImage extends PromptImage {
  id: string;
  dataUrl: string; // full data: URL, for the <img> preview
  name?: string;
}

// Claude accepts these image types. Anything else (a copied file, HTML, rich text)
// is ignored so a normal text paste is never hijacked.
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 10;
const MAX_BYTES = 5 * 1024 * 1024; // ~Claude's per-image cap; oversized ones are skipped

let counter = 0;

function readAsDataURL(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

export function useAttachedImages() {
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [note, setNote] = useState(''); // transient user-facing note (skipped/oversized)

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const picked = Array.from(files).filter((f) => ALLOWED.has(f.type));
    for (const f of picked) {
      if (f.size > MAX_BYTES) {
        setNote(`Skipped ${f.name || 'an image'} — over 5 MB.`);
        continue;
      }
      const dataUrl = await readAsDataURL(f);
      const data = dataUrl.slice(dataUrl.indexOf(',') + 1); // strip "data:<type>;base64,"
      setImages((prev) => {
        if (prev.length >= MAX_IMAGES) {
          setNote(`Only ${MAX_IMAGES} images per prompt.`);
          return prev;
        }
        return [...prev, { id: `img-${++counter}`, media_type: f.type, data, dataUrl, name: f.name || undefined }];
      });
    }
  }, []);

  // Clipboard paste: pull any image items, and only preventDefault when we actually
  // took one, so pasting plain text into the textarea still works normally.
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      // DataTransferItemList is array-like but not iterable — index it.
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file' && ALLOWED.has(it.type)) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        setNote('');
        void addFiles(files);
      }
    },
    [addFiles],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const files = e.dataTransfer?.files;
      if (files && files.length) {
        e.preventDefault();
        setNote('');
        void addFiles(files);
      }
    },
    [addFiles],
  );

  const remove = useCallback((id: string) => setImages((prev) => prev.filter((i) => i.id !== id)), []);
  const clear = useCallback(() => {
    setImages([]);
    setNote('');
  }, []);

  /** The wire payload (drops the preview-only fields). */
  const payload = useCallback((): PromptImage[] => images.map(({ media_type, data }) => ({ media_type, data })), [images]);

  return { images, note, addFiles, onPaste, onDrop, remove, clear, payload };
}

/** Row of thumbnail previews with a remove button on each. */
export function ImageStrip({ images, onRemove }: { images: AttachedImage[]; onRemove: (id: string) => void }) {
  if (!images.length) return null;
  return (
    <div className="img-strip">
      {images.map((img) => (
        <div key={img.id} className="img-thumb" title={img.name || img.media_type}>
          <img src={img.dataUrl} alt={img.name || 'pasted image'} />
          <button className="img-remove" title="Remove image" onClick={() => onRemove(img.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
