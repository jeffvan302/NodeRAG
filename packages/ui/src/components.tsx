import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';

export const Icon = ({ name }: { readonly name: string }) => {
  const paths: Record<string, ComponentChildren> = {
    search: <path d="m21 21-4.4-4.4m2.4-5.1a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" />,
    documents: <path d="M7 3h7l4 4v14H7V3Zm7 0v5h5M10 12h5m-5 4h5" />,
    ingest: <path d="M12 16V4m0 0L7 9m5-5 5 5M5 20h14" />,
    activity: <path d="M3 12h4l2-6 4 12 2-6h6" />,
    settings: (
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0-12v2m0 13v2m8.5-8.5h-2m-13 0h-2m14-6.5-1.4 1.4M7.9 16.1l-1.4 1.4m11 0-1.4-1.4M7.9 7.9 6.5 6.5" />
    ),
    logout: <path d="M10 5H5v14h5m4-3 4-4-4-4m4 4H9" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    check: <path d="m5 12 4 4L19 6" />,
    warning: <path d="M12 4 3 20h18L12 4Zm0 5v5m0 3v.01" />,
    copy: <path d="M8 8h11v12H8V8Zm-3 8H4V4h11v1" />,
    arrow: <path d="m9 18 6-6-6-6" />,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" />,
  };
  return (
    <svg
      aria-hidden="true"
      class="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {paths[name] ?? paths['activity']}
    </svg>
  );
};

export const Spinner = () => <span aria-hidden="true" class="spinner" />;

export const StatusPill = ({ value }: { readonly value: string }) => {
  const normalized = value.toLowerCase().replaceAll('_', '-');
  const positive = [
    'ok',
    'ready',
    'operational',
    'succeeded',
    'active',
    'healthy',
    'complete',
  ].some((item) => normalized.includes(item));
  const danger = ['failed', 'missing', 'unavailable', 'error', 'disabled'].some((item) =>
    normalized.includes(item),
  );
  return (
    <span class={`pill ${positive ? 'positive' : danger ? 'danger' : 'neutral'}`}>
      <span class="pill-dot" />
      {value.replaceAll('_', ' ')}
    </span>
  );
};

export const EmptyState = ({
  title,
  detail,
  action,
}: {
  readonly title: string;
  readonly detail: string;
  readonly action?: ComponentChildren;
}) => (
  <div class="empty-state">
    <span class="empty-mark">N</span>
    <h3>{title}</h3>
    <p>{detail}</p>
    {action}
  </div>
);

export const Notice = ({
  kind = 'info',
  children,
}: {
  readonly kind?: 'info' | 'success' | 'warning' | 'danger';
  readonly children: ComponentChildren;
}) => (
  <div class={`notice ${kind}`} role={kind === 'danger' ? 'alert' : 'status'}>
    <Icon name={kind === 'success' ? 'check' : kind === 'info' ? 'activity' : 'warning'} />
    <div>{children}</div>
  </div>
);

export const Modal = ({
  title,
  children,
  close,
  wide = false,
}: {
  readonly title: string;
  readonly children: ComponentChildren;
  readonly close: () => void;
  readonly wide?: boolean;
}) => {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [close]);
  return (
    <div
      class="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.currentTarget === event.target && close()}
    >
      <section
        aria-modal="true"
        class={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-labelledby="modal-title"
      >
        <header>
          <h2 id="modal-title">{title}</h2>
          <button class="icon-button" type="button" onClick={close} aria-label="Close dialog">
            <Icon name="close" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
};

export const Field = ({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ComponentChildren;
}) => (
  <label class="field">
    <span>{label}</span>
    {children}
    {hint === undefined ? null : <small>{hint}</small>}
  </label>
);

export const SkeletonRows = ({ count = 3 }: { readonly count?: number }) => (
  <div class="skeleton-list" aria-label="Loading" aria-busy="true">
    {Array.from({ length: count }, (_, index) => (
      <div class="skeleton" key={index} />
    ))}
  </div>
);
