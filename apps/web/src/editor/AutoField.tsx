import { useId, useState } from 'react';
import { useDebouncedSave } from '../lib/useDebounced';

/**
 * Text field that autosaves after the user pauses typing. Remount it (via `key`) when it starts
 * editing a different entity so pending edits are flushed to the right one.
 */
export function AutoField({
  label,
  value,
  onSave,
  validate,
  multiline = false,
  maxLength,
  placeholder,
  hint,
  autoFocus,
  hideLabel,
}: {
  label: string;
  value: string;
  onSave: (value: string) => void;
  /** Return an error message to block saving. */
  validate?: (value: string) => string | null;
  multiline?: boolean;
  maxLength?: number;
  placeholder?: string;
  hint?: string;
  autoFocus?: boolean;
  hideLabel?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const error = validate?.(draft) ?? null;
  const saveable = error ? value : draft;

  useDebouncedSave(saveable.trim(), value.trim(), onSave);

  const props = {
    id,
    value: draft,
    maxLength,
    placeholder,
    autoFocus,
    className: `input ${error ? 'border-red-500/70' : ''}`,
    'aria-invalid': !!error,
    'aria-describedby': error || hint ? `${id}-msg` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(e.target.value),
  };

  return (
    <div>
      <label className={hideLabel ? 'sr-only' : 'label'} htmlFor={id}>
        {label}
      </label>
      {multiline ? <textarea rows={4} {...props} /> : <input {...props} />}
      {(error || hint) && (
        <p id={`${id}-msg`} className={`mt-1 text-xs ${error ? 'text-red-300' : 'text-slate-500'}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
