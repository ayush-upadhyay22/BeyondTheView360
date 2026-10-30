import { useEffect, useRef, type ReactNode } from 'react';
import { CloseIcon } from './icons';

/** Modal built on the native <dialog> element: focus trapping and Escape handling come free. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby="dialog-title"
      className={`max-h-[min(92vh,56rem)] w-[calc(100%-2rem)] ${wide ? 'max-w-3xl' : 'max-w-lg'} overflow-y-auto rounded-2xl border border-ink-600 bg-ink-900 p-0 text-slate-100 shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm`}
    >
      {open && (
        <div className="p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 id="dialog-title" className="text-lg font-semibold">
              {title}
            </h2>
            <button
              type="button"
              className="rounded p-1 text-slate-400 hover:text-white"
              onClick={onClose}
              aria-label="Close"
            >
              <CloseIcon size={18} />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
