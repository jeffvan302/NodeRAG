import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { Icon, Modal, Notice, Spinner } from './components.js';
import { MarkdownViewer } from './markdown-viewer.js';
import { appUrl } from './url.js';
import type { ViewerResearchAction } from './viewer-research.js';

interface SearchNavigation {
  readonly previous: (() => void) | null;
  readonly next: (() => void) | null;
}

const normalizedWords = (value: string): readonly string[] =>
  value
    .normalize('NFC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .match(/[\p{L}\p{N}]{2,}/gu) ?? [];

const citationTarget = (root: HTMLElement, citation: string): HTMLElement | null => {
  const citationWords = [...new Set(normalizedWords(citation))];
  if (citationWords.length === 0) return null;
  const citationSet = new Set(citationWords);
  let best: { readonly element: HTMLElement; readonly score: number } | null = null;
  const candidates = root.querySelectorAll<HTMLElement>(
    'h1, h2, h3, h4, h5, h6, p, li, blockquote, td, th, pre',
  );
  for (const element of candidates) {
    const candidateWords = [...new Set(normalizedWords(element.textContent ?? ''))];
    if (candidateWords.length < 2) continue;
    const shared = candidateWords.filter((word) => citationSet.has(word)).length;
    if (shared < Math.min(3, candidateWords.length)) continue;
    const precision = shared / candidateWords.length;
    const coverage = shared / citationWords.length;
    const score = precision * 0.72 + Math.min(1, coverage * 4) * 0.28;
    if (best === null || score > best.score) best = { element, score };
  }
  return best?.element ?? null;
};

export const MarkdownSearchViewer = ({
  documentId,
  title,
  format,
  markdown,
  loading,
  error,
  colorScheme,
  confidence,
  citationKey,
  citationText,
  citationCharacterStart,
  searchNavigation,
  navigationLabel = 'search passages',
  researchAction,
  showSourcePassage,
  close,
}: {
  readonly documentId: number;
  readonly title: string;
  readonly format: string;
  readonly markdown: string;
  readonly loading: boolean;
  readonly error: string;
  readonly colorScheme: string;
  readonly confidence: number;
  readonly citationKey: string;
  readonly citationText: string;
  readonly citationCharacterStart?: number;
  readonly searchNavigation: SearchNavigation;
  readonly navigationLabel?: string;
  readonly researchAction?: ViewerResearchAction;
  readonly showSourcePassage: () => void;
  readonly close: () => void;
}) => {
  const shell = useRef<HTMLDivElement>(null);
  const currentSearchNavigation = useRef(searchNavigation);
  const currentResearchAction = useRef(researchAction);

  useLayoutEffect(() => {
    currentSearchNavigation.current = searchNavigation;
  }, [searchNavigation]);

  useLayoutEffect(() => {
    currentResearchAction.current = researchAction;
  }, [researchAction]);

  const reader = (): HTMLElement | null =>
    shell.current?.querySelector<HTMLElement>('.markdown-document, .markdown-source') ?? null;

  const scrollReader = (direction: -1 | 1) => {
    const target = reader();
    if (target === null) return;
    target.scrollBy({
      top: direction * Math.max(240, target.clientHeight * 0.68),
      behavior: 'smooth',
    });
  };

  useEffect(() => {
    if (loading || error !== '' || markdown === '') return;
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        const target = reader();
        if (target === null) return;
        for (const previous of target.querySelectorAll('.markdown-citation-target')) {
          previous.classList.remove('markdown-citation-target');
        }
        const match = citationTarget(target, citationText);
        if (match !== null) {
          match.classList.add('markdown-citation-target');
          match.scrollIntoView({ block: 'center' });
          return;
        }
        const sourcePosition = Math.max(0, citationCharacterStart ?? 0);
        const fraction = markdown.length === 0 ? 0 : Math.min(1, sourcePosition / markdown.length);
        target.scrollTo({
          top: fraction * Math.max(0, target.scrollHeight - target.clientHeight),
        });
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [citationCharacterStart, citationKey, citationText, error, loading, markdown]);

  useLayoutEffect(() => {
    const navigateWithArrowKeys = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, select, textarea, [contenteditable="true"]') !== null
      )
        return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        scrollReader(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        scrollReader(-1);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        currentSearchNavigation.current.next?.();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        currentSearchNavigation.current.previous?.();
      } else if (event.key === '0' && event.repeat === false) {
        event.preventDefault();
        if (currentResearchAction.current?.busy !== true) currentResearchAction.current?.toggle();
      }
    };
    document.addEventListener('keydown', navigateWithArrowKeys);
    return () => document.removeEventListener('keydown', navigateWithArrowKeys);
  }, []);

  const normalizedFormat = format.trim().toLowerCase();
  const sourceLabel =
    normalizedFormat === 'md'
      ? 'Markdown'
      : normalizedFormat === ''
        ? 'extracted Markdown'
        : `${normalizedFormat.toUpperCase()} extracted Markdown`;

  return (
    <Modal title={`${title} · Markdown`} wide className="markdown-search-modal" close={close}>
      <div class="markdown-search-toolbar" aria-label="Markdown reader controls">
        <button class="primary" type="button" onClick={showSourcePassage}>
          Source passage
        </button>
        <button
          class="secondary"
          type="button"
          title="Scroll up (Left Arrow)"
          aria-keyshortcuts="ArrowLeft"
          disabled={loading || error !== ''}
          onClick={() => scrollReader(-1)}
        >
          Scroll up
        </button>
        <button
          class="secondary"
          type="button"
          title="Scroll down (Right Arrow)"
          aria-keyshortcuts="ArrowRight"
          disabled={loading || error !== ''}
          onClick={() => scrollReader(1)}
        >
          Scroll down
        </button>
        <a
          class="secondary button-link"
          href={appUrl(`/v1/documents/${String(documentId)}/original`)}
        >
          <Icon name="documents" />
          Download original
        </a>
        {researchAction === undefined ? null : (
          <button
            class={
              researchAction.saved ? 'secondary research-toggle saved' : 'secondary research-toggle'
            }
            type="button"
            aria-keyshortcuts="0"
            aria-pressed={researchAction.saved}
            disabled={researchAction.busy}
            onClick={researchAction.toggle}
          >
            {researchAction.busy
              ? 'Updating research…'
              : researchAction.saved
                ? `Remove from ${researchAction.researchName ?? 'research'}`
                : `Save to ${researchAction.researchName ?? 'research'}`}{' '}
            <kbd>0</kbd>
          </button>
        )}
        <span class="markdown-search-keyboard-hint">
          ←/→ scroll · ↑/↓ {navigationLabel}
          {researchAction === undefined ? '' : ' · 0 save/remove'}
        </span>
      </div>
      {researchAction?.feedback === undefined ? null : (
        <Notice kind={researchAction.feedback.kind}>{researchAction.feedback.text}</Notice>
      )}
      <p class="markdown-search-location" role="status">
        Opened at cited passage from {sourceLabel}. Confidence{' '}
        {String(Math.round(Math.min(1, Math.max(0, confidence)) * 100))}%.
      </p>
      {loading ? (
        <div class="markdown-search-loading">
          <Spinner />
          <span>Opening extracted Markdown…</span>
        </div>
      ) : error ? (
        <Notice kind="danger">{error}</Notice>
      ) : (
        <div ref={shell} class="markdown-search-stage">
          <MarkdownViewer markdown={markdown} colorScheme={colorScheme} />
        </div>
      )}
    </Modal>
  );
};
