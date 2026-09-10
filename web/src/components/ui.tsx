import clsx from 'clsx';
import { useState, type ReactNode } from 'react';
import { ImageOff } from 'lucide-react';

import type { DownloadStatus } from '../api';

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={clsx('rounded-xl border border-ink-800 bg-ink-900/60 p-4', className)}>
      {children}
    </div>
  );
}

/**
 * Cover art with a placeholder.
 *
 * Bangumi's images are hotlinked and occasionally 404, and a subscription
 * whose subject has never been fetched has no art at all — both need to leave
 * a box of the right shape behind rather than collapsing the layout around
 * them.
 */
export function Poster({
  src,
  alt,
  className
}: {
  src?: string | null;
  alt: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const shape = clsx('overflow-hidden rounded-md bg-ink-800', className);

  if (!src || broken) {
    return (
      <div className={clsx(shape, 'grid place-items-center')} aria-hidden>
        <ImageOff className="size-4 text-ink-600" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setBroken(true)}
      className={clsx(shape, 'object-cover')}
    />
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  disabled,
  type = 'button',
  className,
  title
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
  title?: string;
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition',
        'disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        variant === 'primary' && 'bg-brand font-semibold text-ink-950 hover:bg-brand/85',
        variant === 'danger' && 'bg-red-600/90 text-white hover:bg-red-600',
        variant === 'default' &&
          'border border-ink-700 bg-ink-800 text-ink-100 hover:border-ink-500 hover:bg-ink-700',
        variant === 'ghost' && 'text-ink-300 hover:bg-ink-800 hover:text-ink-100',
        className
      )}
    >
      {children}
    </button>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  className,
  onKeyDown,
  min,
  max
}: {
  value: string | number;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'number';
  className?: string;
  onKeyDown?: (event: React.KeyboardEvent) => void;
  min?: number;
  max?: number;
}) {
  return (
    <input
      type={type}
      value={value}
      min={min}
      max={max}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      onChange={(event) => onChange(event.target.value)}
      className={clsx(
        'w-full rounded-lg border border-ink-700 bg-ink-950/70 px-3 py-2 text-sm',
        'placeholder:text-ink-500 focus:border-brand focus:ring-1 focus:ring-brand focus:outline-none',
        className
      )}
    />
  );
}

export function Label({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5">
      <div className="text-xs font-medium text-ink-300">{children}</div>
      {hint && <div className="mt-0.5 text-[11px] leading-snug text-ink-500">{hint}</div>}
    </div>
  );
}

/** `progress` is Haro's eye colour: something is happening, nothing is wrong. */
export type Tone = 'neutral' | 'brand' | 'progress' | 'success' | 'warn' | 'danger';

export function Badge({
  children,
  tone = 'neutral',
  title
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-ink-800 text-ink-300',
        tone === 'brand' && 'bg-brand text-ink-950',
        tone === 'progress' && 'bg-eye/15 text-eye',
        tone === 'success' && 'bg-brand/15 text-brand',
        tone === 'warn' && 'bg-amber-500/15 text-amber-400',
        tone === 'danger' && 'bg-red-500/15 text-red-400'
      )}
    >
      {children}
    </span>
  );
}

/**
 * Green means it is in the library, amber means it is on its way.
 *
 * Three of these used to share the brand accent, which read fine while that
 * accent was violet and would now make "downloading" and "imported" the same
 * colour.
 */
const STATUS_TONE: Record<DownloadStatus | 'missing', Tone> = {
  missing: 'neutral',
  queued: 'neutral',
  downloading: 'progress',
  completed: 'progress',
  importing: 'progress',
  imported: 'success',
  failed: 'danger',
  skipped: 'neutral'
};

export function StatusBadge({ status }: { status: DownloadStatus | 'missing' }) {
  return <Badge tone={STATUS_TONE[status]}>{status}</Badge>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-ink-500">
      <span className="size-3.5 animate-spin rounded-full border-2 border-ink-700 border-t-brand" />
      {label ?? 'Loading…'}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-ink-800 px-6 py-12 text-center">
      <div className="text-sm font-medium text-ink-300">{title}</div>
      {description && (
        <div className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-ink-500">
          {description}
        </div>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs break-title text-red-300">
      {children}
    </div>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
      <div
        className="h-full rounded-full bg-brand transition-[width]"
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </div>
  );
}

/** Comma/space separated text ⇄ string[] for the filter editor. */
export function TagInput({
  value,
  onChange,
  placeholder
}: {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}) {
  return (
    <Input
      value={value.join(', ')}
      placeholder={placeholder}
      onChange={(raw) =>
        onChange(
          raw
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        )
      }
    />
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className={clsx(
          'w-full rounded-2xl border border-ink-800 bg-ink-900 shadow-2xl',
          wide ? 'max-w-4xl' : 'max-w-xl'
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-800 px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
