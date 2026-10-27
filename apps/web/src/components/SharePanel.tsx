import { useId, useState } from 'react';
import type { TourVisibility } from '@btv/shared';
import { embedSnippet, shareUrl } from '../lib/share';
import { CopyIcon } from './icons';

export function CopyField({
  label,
  value,
  multiline = false,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  const id = useId();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API unavailable (insecure context): select the text so the user can copy it.
      (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.select();
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const common = {
    id,
    readOnly: true,
    value,
    className: 'input font-mono text-xs',
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => e.target.select(),
  };

  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="flex items-start gap-2">
        {multiline ? <textarea rows={4} {...common} /> : <input {...common} />}
        <button type="button" className="btn-secondary shrink-0" onClick={() => void copy()}>
          <CopyIcon size={16} />
          <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
    </div>
  );
}

const VISIBILITY_NOTE: Record<TourVisibility, string> = {
  private: 'This tour is private: only you can open these links. Change visibility to share it.',
  unlisted: 'Anyone with the link can view this tour. It is not listed anywhere.',
  public: 'This tour is public. Anyone with the link can view it.',
};

export function SharePanel({
  shareId,
  title,
  visibility,
}: {
  shareId: string;
  title: string;
  visibility: TourVisibility;
}) {
  const [autoplay, setAutoplay] = useState(false);
  const [hideUi, setHideUi] = useState(false);
  const options = { autoplay, ui: !hideUi };
  return (
    <div className="space-y-4">
      <p
        className={`rounded-lg px-3 py-2 text-sm ${
          visibility === 'private'
            ? 'border border-amber-500/30 bg-amber-500/10 text-amber-200'
            : 'bg-ink-800 text-slate-300'
        }`}
      >
        {VISIBILITY_NOTE[visibility]}
      </p>
      <fieldset className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <legend className="label">Options</legend>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="accent-brand-500"
            checked={autoplay}
            onChange={(e) => setAutoplay(e.target.checked)}
          />
          Start the walk-through automatically
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="accent-brand-500"
            checked={hideUi}
            onChange={(e) => setHideUi(e.target.checked)}
          />
          Hide all controls
        </label>
      </fieldset>
      <CopyField label="Share link" value={shareUrl(shareId, undefined, options)} />
      <CopyField
        label="Embed code"
        value={embedSnippet(shareId, title, undefined, options)}
        multiline
      />
      <a
        className="btn-ghost -ml-2"
        href={shareUrl(shareId)}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open public page ↗
      </a>
    </div>
  );
}
