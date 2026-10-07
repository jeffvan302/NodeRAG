import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { displayError } from './api.js';
import { Icon, Modal, Notice, Spinner } from './components.js';
import { appUrl } from './url.js';
import type { ViewerResearchAction } from './viewer-research.js';

const loadPdfJs = async () => {
  const pdfJs = await import('pdfjs-dist');
  pdfJs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  return pdfJs;
};

interface PdfRenderTask {
  readonly promise: Promise<void>;
  cancel(): void;
}

interface PdfViewport {
  readonly width: number;
  readonly height: number;
  convertToViewportPoint(x: number, y: number): readonly number[];
}

interface PdfTextItem {
  readonly str: string;
  readonly dir: string;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly hasEOL?: boolean;
}

interface PdfTextContent {
  readonly items: readonly (PdfTextItem | Readonly<Record<string, unknown>>)[];
}

interface PdfPage {
  getViewport(options: { readonly scale: number }): PdfViewport;
  getTextContent(options?: { readonly disableNormalization?: boolean }): Promise<PdfTextContent>;
  render(options: {
    readonly canvas: HTMLCanvasElement;
    readonly viewport: unknown;
    readonly transform?: readonly number[];
    readonly background: string;
  }): PdfRenderTask;
}

interface PdfDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}

interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

interface StageSize {
  readonly width: number;
  readonly height: number;
}

type Zoom = 'fit' | number;

interface SearchNavigation {
  readonly previous: (() => void) | null;
  readonly next: (() => void) | null;
}

export interface PdfEvidence {
  readonly kind: 'exact' | 'semantic';
  readonly text: string;
  readonly confidence: number;
}

interface HighlightRectangle {
  readonly kind: PdfEvidence['kind'];
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface IndexedTextItem {
  readonly item: PdfTextItem;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface PreparedPdfTextLayer {
  readonly pageNumber: number;
  readonly viewport: PdfViewport;
  readonly content: PdfTextContent;
}

const normalizedEvidenceText = (value: string): string =>
  value
    .normalize('NFC')
    .toLocaleLowerCase()
    .replace(/\u00ad/gu, '')
    .replace(/[‐‑‒–—―]/gu, '-')
    .replace(/[ﬀﬁﬂﬃﬄﬅﬆ]/gu, (ligature) => {
      const replacements: Readonly<Record<string, string>> = {
        ﬀ: 'ff',
        ﬁ: 'fi',
        ﬂ: 'fl',
        ﬃ: 'ffi',
        ﬄ: 'ffl',
        ﬅ: 'ft',
        ﬆ: 'st',
      };
      return replacements[ligature] ?? ligature;
    })
    .replace(/\s+/gu, ' ')
    .trim();

const indexedPageText = (content: PdfTextContent): { text: string; items: IndexedTextItem[] } => {
  let text = '';
  const items: IndexedTextItem[] = [];
  let previous: PdfTextItem | undefined;
  for (const value of content.items) {
    if (!('str' in value) || typeof value.str !== 'string') continue;
    const normalized = normalizedEvidenceText(value.str);
    if (normalized.length === 0) continue;
    const item = value as PdfTextItem;
    if (text.length > 0 && previous !== undefined) {
      const previousX = Number(previous.transform[4] ?? 0);
      const previousY = Number(previous.transform[5] ?? 0);
      const currentX = Number(item.transform[4] ?? 0);
      const currentY = Number(item.transform[5] ?? 0);
      const lineHeight = Math.max(1, Math.abs(previous.height), Math.abs(item.height));
      const sameLine = Math.abs(currentY - previousY) <= lineHeight * 0.45;
      const previousEnd = previousX + Math.abs(previous.width);
      const gap =
        item.dir === 'rtl' ? previousX - (currentX + Math.abs(item.width)) : currentX - previousEnd;
      if (previous.hasEOL === true || !sameLine || gap > lineHeight * 0.12) text += ' ';
    }
    const start = text.length;
    text += normalized;
    items.push({ item, text: normalized, start, end: text.length });
    previous = item;
  }
  return { text, items };
};

const allOccurrences = (text: string, match: string): Array<{ start: number; end: number }> => {
  const output: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (match.length > 0) {
    const start = text.indexOf(match, offset);
    if (start < 0) break;
    output.push({ start, end: start + match.length });
    offset = start + Math.max(1, match.length);
  }
  return output;
};

const tokenRanges = (value: string) =>
  [...value.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));

const exactTokenOccurrences = (
  pageText: string,
  evidenceText: string,
): Array<{ start: number; end: number }> => {
  const pageTokens = tokenRanges(pageText);
  const evidenceTokens = tokenRanges(evidenceText);
  const occurrences: Array<{ start: number; end: number }> = [];
  if (evidenceTokens.length === 0) return occurrences;
  for (let start = 0; start <= pageTokens.length - evidenceTokens.length; start += 1) {
    const matches = evidenceTokens.every(
      (token, offset) => pageTokens[start + offset]?.text === token.text,
    );
    if (!matches) continue;
    const first = pageTokens[start];
    const last = pageTokens[start + evidenceTokens.length - 1];
    if (first !== undefined && last !== undefined)
      occurrences.push({ start: first.start, end: last.end });
    if (occurrences.length >= 12) break;
  }
  return occurrences;
};

const semanticTokenOccurrence = (
  pageText: string,
  evidenceText: string,
): { start: number; end: number } | undefined => {
  const pageTokens = tokenRanges(pageText);
  const evidenceTokens = tokenRanges(evidenceText);
  if (evidenceTokens.length < 3 || pageTokens.length < 3) return undefined;
  const evidenceCounts = new Map<string, number>();
  for (const token of evidenceTokens)
    evidenceCounts.set(token.text, (evidenceCounts.get(token.text) ?? 0) + 1);
  let best: { readonly start: number; readonly end: number; readonly score: number } | undefined;
  const minimumWindow = Math.max(3, Math.floor(evidenceTokens.length * 0.7));
  const maximumWindow = Math.min(pageTokens.length, Math.ceil(evidenceTokens.length * 1.3));
  for (let size = minimumWindow; size <= maximumWindow; size += 1) {
    for (let start = 0; start <= pageTokens.length - size; start += 1) {
      const window = pageTokens.slice(start, start + size);
      const available = new Map<string, number>();
      for (const token of window) available.set(token.text, (available.get(token.text) ?? 0) + 1);
      let shared = 0;
      for (const [token, count] of evidenceCounts)
        shared += Math.min(count, available.get(token) ?? 0);
      const coverage = shared / evidenceTokens.length;
      const precision = shared / window.length;
      if (coverage < 0.6 || precision < 0.5) continue;
      let ordered = 0;
      let cursor = 0;
      for (const token of evidenceTokens) {
        const found = window.findIndex(
          (candidate, index) => index >= cursor && candidate.text === token.text,
        );
        if (found < 0) continue;
        ordered += 1;
        cursor = found + 1;
      }
      const score = coverage * 0.5 + precision * 0.2 + (ordered / evidenceTokens.length) * 0.3;
      const first = window[0];
      const last = window.at(-1);
      if (first === undefined || last === undefined || (best !== undefined && best.score >= score))
        continue;
      best = { start: first.start, end: last.end, score };
    }
  }
  return best === undefined ? undefined : { start: best.start, end: best.end };
};

const highlightRectangles = (
  content: PdfTextContent,
  viewport: PdfViewport,
  evidence: readonly PdfEvidence[],
): readonly HighlightRectangle[] => {
  const indexed = indexedPageText(content);
  const rectangles: HighlightRectangle[] = [];
  const deduplicated = new Set<string>();
  for (const itemEvidence of [...evidence].sort((left, right) =>
    left.kind === right.kind ? 0 : left.kind === 'semantic' ? -1 : 1,
  )) {
    const normalized = normalizedEvidenceText(itemEvidence.text);
    let occurrences = allOccurrences(indexed.text, normalized);
    if (occurrences.length === 0) occurrences = exactTokenOccurrences(indexed.text, normalized);
    if (occurrences.length === 0 && itemEvidence.kind === 'semantic') {
      const tokenOccurrence = semanticTokenOccurrence(indexed.text, normalized);
      if (tokenOccurrence !== undefined) occurrences = [tokenOccurrence];
    }
    for (const occurrence of occurrences.slice(0, 12)) {
      for (const indexedItem of indexed.items) {
        const overlapStart = Math.max(occurrence.start, indexedItem.start);
        const overlapEnd = Math.min(occurrence.end, indexedItem.end);
        if (overlapStart >= overlapEnd) continue;
        const item = indexedItem.item;
        const itemX = Number(item.transform[4] ?? 0);
        const itemY = Number(item.transform[5] ?? 0);
        const width = Math.abs(item.width);
        const height = Math.max(1, Math.abs(item.height));
        const startRatio = (overlapStart - indexedItem.start) / indexedItem.text.length;
        const endRatio = (overlapEnd - indexedItem.start) / indexedItem.text.length;
        const leftRatio = item.dir === 'rtl' ? 1 - endRatio : startRatio;
        const rightRatio = item.dir === 'rtl' ? 1 - startRatio : endRatio;
        const first = viewport.convertToViewportPoint(itemX + width * leftRatio, itemY);
        const second = viewport.convertToViewportPoint(itemX + width * rightRatio, itemY + height);
        const left = Math.min(Number(first[0] ?? 0), Number(second[0] ?? 0));
        const top = Math.min(Number(first[1] ?? 0), Number(second[1] ?? 0));
        const rectangleWidth = Math.max(
          2,
          Math.abs(Number(second[0] ?? 0) - Number(first[0] ?? 0)),
        );
        const rectangleHeight = Math.max(
          2,
          Math.abs(Number(second[1] ?? 0) - Number(first[1] ?? 0)),
        );
        const key = `${itemEvidence.kind}:${left.toFixed(1)}:${top.toFixed(1)}:${rectangleWidth.toFixed(1)}:${rectangleHeight.toFixed(1)}`;
        if (deduplicated.has(key)) continue;
        deduplicated.add(key);
        rectangles.push({
          kind: itemEvidence.kind,
          left,
          top,
          width: rectangleWidth,
          height: rectangleHeight,
        });
      }
    }
  }
  return rectangles;
};

const measuredContentSize = (element: HTMLElement): StageSize => {
  const style = window.getComputedStyle(element);
  return {
    width: Math.max(
      1,
      element.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight),
    ),
    height: Math.max(
      1,
      element.clientHeight -
        Number.parseFloat(style.paddingTop) -
        Number.parseFloat(style.paddingBottom),
    ),
  };
};

export const PdfViewer = ({
  documentId,
  sourceUrl: sourceUrlOverride,
  title,
  initialPage,
  close,
  showSourcePassage,
  citationKey,
  confidence,
  searchNavigation,
  navigationLabel = 'search passages',
  researchAction,
  citationPageEnd,
  evidence = [],
  evidenceLoading = false,
  semanticEvidenceStatus = 'not-requested',
  highlightsEnabled = true,
  onHighlightsChange,
}: {
  readonly documentId: number;
  readonly sourceUrl?: string;
  readonly title: string;
  readonly initialPage: number;
  readonly close: () => void;
  readonly showSourcePassage?: () => void;
  readonly citationKey?: string;
  readonly confidence?: number;
  readonly searchNavigation?: SearchNavigation;
  readonly navigationLabel?: string;
  readonly researchAction?: ViewerResearchAction;
  readonly citationPageEnd?: number;
  readonly evidence?: readonly PdfEvidence[];
  readonly evidenceLoading?: boolean;
  readonly semanticEvidenceStatus?: 'not-requested' | 'loading' | 'ready' | 'unavailable';
  readonly highlightsEnabled?: boolean;
  readonly onHighlightsChange?: (enabled: boolean) => void;
}) => {
  const [pdf, setPdf] = useState<PdfDocument | null>(null);
  const [pageNumber, setPageNumber] = useState(Math.max(1, initialPage));
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [stageSize, setStageSize] = useState<StageSize>({ width: 1, height: 1 });
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [highlights, setHighlights] = useState<readonly HighlightRectangle[]>([]);
  const [pageSize, setPageSize] = useState<StageSize>({ width: 1, height: 1 });
  const [textLayer, setTextLayer] = useState<PreparedPdfTextLayer | null>(null);
  const [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const currentSearchNavigation = useRef(searchNavigation);
  const currentResearchAction = useRef(researchAction);
  const currentPageNumber = useRef(pageNumber);
  const sourceUrl = sourceUrlOverride ?? appUrl(`/v1/documents/${String(documentId)}/original`);

  useEffect(() => {
    const target = stage.current;
    if (target === null) return;
    const measure = () => {
      const next = measuredContentSize(target);
      setStageSize((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(() => {
    let active = true;
    setPdf(null);
    setLoading(true);
    setError('');
    let task: PdfLoadingTask | undefined;
    void loadPdfJs()
      .then((pdfJs) => {
        if (!active) return null;
        task = pdfJs.getDocument({
          url: sourceUrl,
          withCredentials: true,
        }) as unknown as PdfLoadingTask;
        return task.promise;
      })
      .then((loaded) => {
        if (!active || loaded === null) return;
        setPdf(loaded);
        setPageNumber((current) => Math.min(Math.max(1, current), loaded.numPages));
      })
      .catch((reason: unknown) => {
        if (active) setError(`The PDF could not be opened: ${displayError(reason)}`);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
      void task?.destroy();
    };
  }, [documentId, sourceUrl]);

  useLayoutEffect(() => {
    setPageNumber(Math.max(1, initialPage));
  }, [citationKey, documentId, initialPage]);

  useLayoutEffect(() => {
    currentSearchNavigation.current = searchNavigation;
  }, [searchNavigation]);

  useLayoutEffect(() => {
    currentResearchAction.current = researchAction;
  }, [researchAction]);

  useLayoutEffect(() => {
    currentPageNumber.current = pageNumber;
  }, [pageNumber]);

  useEffect(() => {
    if (pdf === null || canvas.current === null) return;
    let active = true;
    let renderTask: PdfRenderTask | undefined;
    setRendering(true);
    setHighlights([]);
    setTextLayer(null);
    setError('');
    void pdf
      .getPage(pageNumber)
      .then((page) => {
        if (!active || canvas.current === null) return;
        const naturalViewport = page.getViewport({ scale: 1 });
        const scale =
          zoom === 'fit'
            ? Math.min(
                3.5,
                Math.max(
                  0.25,
                  Math.min(
                    stageSize.width / naturalViewport.width,
                    stageSize.height / naturalViewport.height,
                  ),
                ),
              )
            : zoom;
        const viewport = page.getViewport({ scale });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        const target = canvas.current;
        target.width = Math.floor(viewport.width * outputScale);
        target.height = Math.floor(viewport.height * outputScale);
        target.style.width = `${String(Math.floor(viewport.width))}px`;
        target.style.height = `${String(Math.floor(viewport.height))}px`;
        setPageSize({ width: viewport.width, height: viewport.height });
        renderTask = page.render({
          canvas: target,
          viewport,
          ...(outputScale === 1 ? {} : { transform: [outputScale, 0, 0, outputScale, 0, 0] }),
          background: 'rgb(255,255,255)',
        });
        const textContent = page.getTextContent({ disableNormalization: true }).then((content) => {
          if (active) setTextLayer({ pageNumber, viewport, content });
        });
        return Promise.all([renderTask.promise, textContent]);
      })
      .catch((reason: unknown) => {
        if (active && !(reason instanceof Error && reason.name === 'RenderingCancelledException')) {
          setError(`This PDF page could not be displayed: ${displayError(reason)}`);
        }
      })
      .finally(() => active && setRendering(false));
    return () => {
      active = false;
      renderTask?.cancel();
    };
  }, [pageNumber, pdf, stageSize.height, stageSize.width, zoom]);

  useLayoutEffect(() => {
    if (textLayer === null || textLayer.pageNumber !== pageNumber) {
      setHighlights([]);
      return;
    }
    const lastCitationPage = Math.max(initialPage, citationPageEnd ?? initialPage);
    setHighlights(
      pageNumber >= initialPage && pageNumber <= lastCitationPage
        ? highlightRectangles(textLayer.content, textLayer.viewport, evidence)
        : [],
    );
  }, [citationPageEnd, evidence, initialPage, pageNumber, textLayer]);

  const maximumPage =
    pdf?.numPages ?? Math.max(1, pageNumber, initialPage, citationPageEnd ?? initialPage);
  const moveToPage = (page: number) =>
    setPageNumber(Math.min(maximumPage, Math.max(1, Math.trunc(page) || 1)));

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
        setPageNumber((current) =>
          pdf === null ? current + 1 : Math.min(maximumPage, current + 1),
        );
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setPageNumber((current) => Math.max(1, current - 1));
      } else if (event.key === 'ArrowDown' && currentSearchNavigation.current !== undefined) {
        event.preventDefault();
        currentSearchNavigation.current.next?.();
      } else if (event.key === 'ArrowUp' && currentSearchNavigation.current !== undefined) {
        event.preventDefault();
        currentSearchNavigation.current.previous?.();
      } else if (event.key === '0' && event.repeat === false) {
        event.preventDefault();
        const action = currentResearchAction.current;
        if (action === undefined) return;
        if (action.page !== undefined) {
          if (action.page.busyPage === null) action.page.toggle(currentPageNumber.current);
        } else if (!action.busy) action.toggle();
      }
    };
    document.addEventListener('keydown', navigateWithArrowKeys);
    return () => document.removeEventListener('keydown', navigateWithArrowKeys);
  }, [maximumPage, pdf]);

  const pageResearchAction = researchAction?.page;
  const researchSaved =
    pageResearchAction === undefined
      ? (researchAction?.saved ?? false)
      : pageResearchAction.savedPages.has(pageNumber);
  const researchBusy =
    pageResearchAction === undefined
      ? (researchAction?.busy ?? false)
      : pageResearchAction.busyPage !== null;
  const toggleResearch = () =>
    pageResearchAction === undefined
      ? researchAction?.toggle()
      : pageResearchAction.toggle(pageNumber);
  const openedPage = Math.min(maximumPage, Math.max(1, initialPage));
  const lastCitationPage = Math.max(initialPage, citationPageEnd ?? initialPage);
  const pageCanHaveHighlights = pageNumber >= initialPage && pageNumber <= lastCitationPage;
  const semanticEvidenceCount = evidence.filter(({ kind }) => kind === 'semantic').length;
  const semanticHighlightCount = highlights.filter(({ kind }) => kind === 'semantic').length;

  return (
    <Modal title={`${title} · PDF`} wide className="pdf-modal" close={close}>
      <div class="pdf-toolbar" aria-label="PDF controls">
        {showSourcePassage === undefined ? null : (
          <button class="primary" type="button" onClick={showSourcePassage}>
            Source passage
          </button>
        )}
        <button
          class="secondary"
          type="button"
          title="Previous page (Left Arrow)"
          aria-keyshortcuts="ArrowLeft"
          disabled={pdf === null || pageNumber <= 1}
          onClick={() => moveToPage(pageNumber - 1)}
        >
          Previous page
        </button>
        <label class="pdf-page-control">
          <span>Page</span>
          <input
            aria-label="PDF page"
            type="number"
            min="1"
            max={maximumPage}
            value={pageNumber}
            disabled={pdf === null}
            onChange={(event) => moveToPage(Number(event.currentTarget.value))}
          />
          <span>of {pdf === null ? '…' : String(maximumPage)}</span>
        </label>
        <button
          class="secondary"
          type="button"
          title="Next page (Right Arrow)"
          aria-keyshortcuts="ArrowRight"
          disabled={pdf === null || pageNumber >= maximumPage}
          onClick={() => moveToPage(pageNumber + 1)}
        >
          Next page
        </button>
        <label class="pdf-zoom-control">
          <span>Zoom</span>
          <select
            aria-label="PDF zoom"
            value={zoom}
            disabled={pdf === null}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setZoom(value === 'fit' ? 'fit' : Number(value));
            }}
          >
            <option value="fit">Fit to window</option>
            <option value="0.75">75%</option>
            <option value="1">100%</option>
            <option value="1.25">125%</option>
            <option value="1.5">150%</option>
            <option value="2">200%</option>
          </select>
        </label>
        <a class="secondary button-link" href={sourceUrl}>
          <Icon name="documents" />
          Download original
        </a>
        {searchNavigation === undefined ? null : (
          <button
            class="secondary"
            type="button"
            aria-pressed={highlightsEnabled}
            onClick={() => onHighlightsChange?.(!highlightsEnabled)}
          >
            Highlights {highlightsEnabled ? 'on' : 'off'}
          </button>
        )}
        {researchAction === undefined ? null : (
          <button
            class={researchSaved ? 'secondary research-toggle saved' : 'secondary research-toggle'}
            type="button"
            aria-keyshortcuts="0"
            aria-pressed={researchSaved}
            disabled={researchBusy}
            onClick={toggleResearch}
          >
            {researchBusy
              ? 'Updating research…'
              : researchSaved
                ? `${pageResearchAction === undefined ? 'Remove from' : `Remove page ${String(pageNumber)} from`} ${researchAction.researchName ?? 'research'}`
                : `${pageResearchAction === undefined ? 'Save to' : `Save page ${String(pageNumber)} to`} ${researchAction.researchName ?? 'research'}`}{' '}
            <kbd>0</kbd>
          </button>
        )}
        {searchNavigation === undefined ? null : (
          <span class="pdf-keyboard-hint">
            ←/→ pages · ↑/↓ {navigationLabel}
            {researchAction === undefined ? '' : ' · 0 save/remove'}
          </span>
        )}
      </div>
      {researchAction?.feedback === undefined ? null : (
        <Notice kind={researchAction.feedback.kind}>{researchAction.feedback.text}</Notice>
      )}
      <p class="pdf-location" role="status">
        {pageNumber === openedPage
          ? `${confidence === undefined ? 'Opened at page' : 'Opened at cited page'} ${String(openedPage)}.`
          : `Viewing page ${String(pageNumber)}. Opened from ${confidence === undefined ? 'page' : 'cited page'} ${String(openedPage)}.`}
        {confidence === undefined
          ? ''
          : ` Confidence ${String(Math.round(Math.min(1, Math.max(0, confidence)) * 100))}%.`}
      </p>
      {searchNavigation === undefined ? null : (
        <div class="pdf-highlight-status" aria-live="polite">
          <span>
            <i class="pdf-highlight-swatch exact" />
            Exact words and phrases
          </span>
          <span>
            <i class="pdf-highlight-swatch semantic" />
            Semantic sentences
          </span>
          {evidenceLoading ? <span>Finding semantic highlights…</span> : null}
          {!evidenceLoading && semanticEvidenceStatus === 'unavailable' ? (
            <span class="pdf-highlight-warning">
              Semantic highlighting is temporarily unavailable for this passage.
            </span>
          ) : null}
          {!evidenceLoading &&
          semanticEvidenceStatus === 'ready' &&
          pageCanHaveHighlights &&
          semanticEvidenceCount === 0 ? (
            <span>No semantic sentence met the confidence threshold.</span>
          ) : null}
          {!evidenceLoading &&
          semanticEvidenceStatus === 'ready' &&
          pageCanHaveHighlights &&
          semanticEvidenceCount > 0 &&
          textLayer !== null &&
          semanticHighlightCount === 0 ? (
            <span>No semantic sentence could be aligned with this PDF page.</span>
          ) : null}
          {!evidenceLoading &&
          highlightsEnabled &&
          evidence.length > 0 &&
          highlights.length === 0 ? (
            <span>
              {pageCanHaveHighlights
                ? 'No matching PDF text was found on this page.'
                : 'Highlights apply to the cited page.'}
            </span>
          ) : null}
        </div>
      )}
      {error ? <Notice kind="danger">{error}</Notice> : null}
      <div ref={stage} class="pdf-stage" aria-busy={loading || rendering}>
        {loading ? (
          <div class="pdf-loading">
            <Spinner />
            <span>Opening PDF…</span>
          </div>
        ) : null}
        <div
          class={loading || error ? 'pdf-page-shell hidden' : 'pdf-page-shell'}
          style={{ width: `${String(pageSize.width)}px`, height: `${String(pageSize.height)}px` }}
        >
          <canvas
            ref={canvas}
            class="pdf-page-canvas"
            aria-label={`PDF page ${String(pageNumber)}`}
          />
          <div
            class={`pdf-highlight-layer ${highlightsEnabled ? '' : 'hidden'}`.trim()}
            aria-hidden="true"
          >
            {highlights.map((rectangle) => (
              <span
                class={`pdf-highlight ${rectangle.kind}`}
                style={{
                  left: `${String(rectangle.left)}px`,
                  top: `${String(rectangle.top)}px`,
                  width: `${String(rectangle.width)}px`,
                  height: `${String(rectangle.height)}px`,
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
};
