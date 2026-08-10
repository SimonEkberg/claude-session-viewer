import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * The "let another agent review the work" surface. Shows the Markdown export and
 * hands over the exact URL an agent (or teammate) can fetch/read to review.
 */
export function ReviewPanel({ id }: { id: string }) {
  const [md, setMd] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const reviewUrl = `${location.origin}${api.reviewUrl(id)}`;

  useEffect(() => {
    setMd('');
    api.reviewMarkdown(id).then(setMd).catch((e) => setMd(`Error: ${e}`));
  }, [id]);

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="review-panel">
      <div className="review-hint">
        <p>
          A de-noised, linear trace built for <b>another agent to review the work</b> — prompts,
          reasoning, actions with targets, and results. Point a reviewing agent at:
        </p>
        <div className="review-url">
          <code>{reviewUrl}</code>
          <button className="btn" onClick={() => copy(reviewUrl)}>
            Copy URL
          </button>
          <button className="btn" onClick={() => copy(md)}>
            {copied ? 'Copied!' : 'Copy Markdown'}
          </button>
        </div>
      </div>
      <pre className="review-md">{md || 'Loading…'}</pre>
    </div>
  );
}
