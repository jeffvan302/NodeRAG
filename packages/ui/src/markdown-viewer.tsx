import DOMPurify from 'dompurify';
import { Marked, Renderer, type Tokens } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import 'katex/dist/katex.min.css';
import { Icon } from './components.js';

type MarkdownView = 'preview' | 'source';

const escapeHtml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const escapeAttribute = (value: string): string =>
  escapeHtml(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const inlineImage = (href: string): boolean =>
  /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/iu.test(href);

export const isManagedChatFileUrl = (href: string): boolean => {
  try {
    const url = new URL(href, location.href);
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
    return (
      url.origin === location.origin &&
      new RegExp(`/chat/${uuid}/file/${uuid}\\.(?:png|jpg|gif|webp)$`, 'u').test(url.pathname)
    );
  } catch {
    return false;
  }
};

export const MarkdownPreview = ({
  markdown,
  colorScheme,
  loadExternalImages = false,
  className = '',
}: {
  readonly markdown: string;
  readonly colorScheme: string;
  readonly loadExternalImages?: boolean;
  readonly className?: string;
}) => {
  const preview = useRef<HTMLDivElement>(null);
  const html = useMemo(
    () => sanitizedMarkdown(markdown || 'Waiting for content…', loadExternalImages),
    [markdown, loadExternalImages],
  );

  useEffect(() => {
    if (preview.current === null) return;
    const root = preview.current;
    const objectUrls: string[] = [];
    let stopped = false;
    void Promise.all([
      renderDiagrams(root, colorScheme, objectUrls, () => stopped),
      renderMath(root, () => stopped),
    ]);
    return () => {
      stopped = true;
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
  }, [colorScheme, html]);

  return (
    <div
      key={`${colorScheme}:${loadExternalImages ? 'external-images' : 'local-images'}`}
      ref={preview}
      class={`markdown-document ${className}`.trim()}
      dir="auto"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

const safeLink = (href: string): boolean =>
  /^(?:https?:|mailto:)/iu.test(href) || isManagedChatFileUrl(href);

const managedImage = (href: string): boolean => {
  try {
    const url = new URL(href, location.href);
    return url.origin === location.origin && /\/v1\/images\/\d+\/content$/u.test(url.pathname);
  } catch {
    return false;
  }
};

const documentRenderer = (loadExternalImages: boolean): Renderer => {
  const renderer = new Renderer();
  renderer.html = ({ text }: Tokens.HTML | Tokens.Tag): string => {
    return escapeHtml(text);
  };
  renderer.link = function ({ href, title, tokens }: Tokens.Link): string {
    const label = this.parser.parseInline(tokens);
    if (!safeLink(href)) {
      return `<span class="markdown-unavailable-link" title="This relative link is not available in the managed preview">${label}</span>`;
    }
    const newWindow = /^https?:/iu.test(href) || isManagedChatFileUrl(href);
    return `<a href="${escapeAttribute(href)}"${title ? ` title="${escapeAttribute(title)}"` : ''}${newWindow ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
  };
  renderer.image = ({ href, title, text }: Tokens.Image): string => {
    const alt = text || 'Document image';
    const allowed =
      inlineImage(href) ||
      managedImage(href) ||
      isManagedChatFileUrl(href) ||
      (loadExternalImages && /^https?:/iu.test(href));
    if (allowed) {
      return `<img src="${escapeAttribute(href)}" alt="${escapeAttribute(alt)}"${title ? ` title="${escapeAttribute(title)}"` : ''} loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
    }
    if (/^https?:/iu.test(href)) {
      return `<span class="markdown-external-image"><span aria-hidden="true">▧</span><span><b>${escapeHtml(alt)}</b><small>External image not loaded automatically</small><a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">Open image in a new tab</a></span></span>`;
    }
    return `<span class="markdown-missing-image"><span aria-hidden="true">▧</span><span><b>${escapeHtml(alt)}</b><small>Relative image files are not part of this managed document.</small></span></span>`;
  };
  return renderer;
};

const sanitizedMarkdown = (markdown: string, loadExternalImages: boolean): string => {
  const parser = new Marked({
    gfm: true,
    breaks: false,
    renderer: documentRenderer(loadExternalImages),
  });
  const rendered = parser.parse(markdown, { async: false });
  return DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    ALLOW_DATA_ATTR: false,
    SANITIZE_NAMED_PROPS: true,
    FORBID_TAGS: [
      'style',
      'form',
      'textarea',
      'select',
      'option',
      'button',
      'iframe',
      'object',
      'embed',
    ],
    FORBID_ATTR: ['style'],
  });
};

let diagramSequence = 0;

const diagramLabel = (source: string): string => {
  const declaration = source.trim().split(/\r?\n/u)[0]?.trim() ?? '';
  if (/^(?:flowchart|graph)\b/iu.test(declaration)) return 'Flowchart';
  if (/^sequenceDiagram\b/iu.test(declaration)) return 'Sequence diagram';
  if (/^classDiagram\b/iu.test(declaration)) return 'Class diagram';
  if (/^stateDiagram/iu.test(declaration)) return 'State diagram';
  if (/^erDiagram\b/iu.test(declaration)) return 'Entity relationship diagram';
  if (/^(?:pie|xychart-beta)\b/iu.test(declaration)) return 'Chart';
  if (/^(?:gantt|timeline)\b/iu.test(declaration)) return 'Timeline diagram';
  return 'Mermaid diagram';
};

const renderDiagrams = async (
  root: HTMLDivElement,
  colorScheme: string,
  objectUrls: string[],
  cancelled: () => boolean,
): Promise<void> => {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')];
  if (blocks.length === 0) return;
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    htmlLabels: false,
    maxTextSize: 100_000,
    theme: colorScheme === 'light' ? 'default' : 'dark',
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
  });

  for (const block of blocks) {
    if (cancelled()) return;
    const source = block.textContent ?? '';
    const original = block.closest('pre');
    if (original === null) continue;
    const figure = document.createElement('figure');
    figure.className = 'markdown-diagram';
    figure.setAttribute('aria-busy', 'true');
    const status = document.createElement('div');
    status.className = 'markdown-diagram-status';
    status.textContent = `Rendering ${diagramLabel(source).toLowerCase()}…`;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Diagram source';
    const sourcePre = document.createElement('pre');
    const sourceCode = document.createElement('code');
    sourceCode.textContent = source;
    sourcePre.append(sourceCode);
    details.append(summary, sourcePre);
    figure.append(status, details);
    original.replaceWith(figure);

    try {
      const rendered = await mermaid.render(`noderag-diagram-${String(++diagramSequence)}`, source);
      const safeSvg = DOMPurify.sanitize(rendered.svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        SANITIZE_NAMED_PROPS: true,
        FORBID_TAGS: ['script', 'foreignObject'],
      });
      const objectUrl = URL.createObjectURL(
        new Blob([safeSvg], { type: 'image/svg+xml;charset=utf-8' }),
      );
      objectUrls.push(objectUrl);
      if (cancelled()) return;
      const image = document.createElement('img');
      image.className = 'markdown-diagram-image';
      image.src = objectUrl;
      image.alt = diagramLabel(source);
      image.decoding = 'async';
      status.replaceWith(image);
      figure.setAttribute('aria-busy', 'false');
    } catch {
      if (cancelled()) return;
      status.className = 'markdown-diagram-status error';
      status.textContent = 'This diagram could not be rendered. Its source is available below.';
      details.open = true;
      figure.setAttribute('aria-busy', 'false');
    }
  }
};

const renderMath = async (root: HTMLDivElement, cancelled: () => boolean): Promise<void> => {
  if (!root.textContent?.includes('$')) return;
  const { default: katex } = await import('katex');
  if (cancelled()) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const candidates: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    if (
      text.data.includes('$') &&
      text.parentElement?.closest('pre,code,a,.katex,.markdown-diagram') === null
    ) {
      candidates.push(text);
    }
  }
  const expressionPattern = /(\$\$([^$]+?)\$\$|\$([^$\n]+?)\$)/gu;
  for (const text of candidates) {
    if (cancelled() || text.parentNode === null) return;
    const matches = [...text.data.matchAll(expressionPattern)].filter((match) => {
      const expression = String(match[2] ?? match[3] ?? '');
      return /[\\^_{}=+*/<>]|\b(?:sum|sqrt|frac|alpha|beta|theta|pi)\b/u.test(expression);
    });
    if (matches.length === 0) continue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      const index = match.index ?? 0;
      fragment.append(document.createTextNode(text.data.slice(cursor, index)));
      const displayMode = match[2] !== undefined;
      const container = document.createElement(displayMode ? 'div' : 'span');
      container.className = displayMode ? 'markdown-math block' : 'markdown-math inline';
      katex.render(String(match[2] ?? match[3] ?? ''), container, {
        displayMode,
        throwOnError: false,
        strict: 'warn',
        trust: false,
        output: 'htmlAndMathml',
      });
      fragment.append(container);
      cursor = index + match[0].length;
    }
    fragment.append(document.createTextNode(text.data.slice(cursor)));
    text.replaceWith(fragment);
  }
};

export const MarkdownViewer = ({
  markdown,
  colorScheme,
  allowExternalImages = true,
}: {
  readonly markdown: string;
  readonly colorScheme: string;
  readonly allowExternalImages?: boolean;
}) => {
  const [view, setView] = useState<MarkdownView>('preview');
  const [loadExternalImages, setLoadExternalImages] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const words = useMemo(() => markdown.trim().split(/\s+/u).filter(Boolean).length, [markdown]);
  const remoteImages = useMemo(
    () =>
      [...markdown.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/giu)].filter(
        (match) => !isManagedChatFileUrl(String(match[1] ?? '')),
      ).length,
    [markdown],
  );

  useEffect(() => {
    setView('preview');
    setLoadExternalImages(false);
    setCopyStatus('idle');
  }, [markdown]);

  useEffect(() => {
    if (!allowExternalImages) setLoadExternalImages(false);
  }, [allowExternalImages]);

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };

  return (
    <section class="markdown-viewer" aria-label="Document text">
      <header class="markdown-toolbar">
        <div class="segmented compact" role="group" aria-label="Markdown display">
          <button
            type="button"
            class={view === 'preview' ? 'selected' : ''}
            aria-pressed={view === 'preview'}
            onClick={() => setView('preview')}
          >
            Preview
          </button>
          <button
            type="button"
            class={view === 'source' ? 'selected' : ''}
            aria-pressed={view === 'source'}
            onClick={() => setView('source')}
          >
            Markdown source
          </button>
        </div>
        <div class="markdown-toolbar-actions">
          <span class="markdown-stat">
            {String(words)} {words === 1 ? 'word' : 'words'}
          </span>
          {remoteImages > 0 && allowExternalImages ? (
            <button
              class="secondary"
              type="button"
              aria-pressed={loadExternalImages}
              onClick={() => setLoadExternalImages((value) => !value)}
            >
              {loadExternalImages
                ? 'Block external images'
                : `Load external images (${String(remoteImages)})`}
            </button>
          ) : null}
          <button class="secondary" type="button" onClick={() => void copyMarkdown()}>
            <Icon name={copyStatus === 'copied' ? 'check' : 'copy'} />
            {copyStatus === 'copied' ? 'Markdown copied' : 'Copy Markdown'}
          </button>
        </div>
      </header>
      {copyStatus === 'failed' ? (
        <p class="markdown-copy-error" role="alert">
          Clipboard access is unavailable. Open Markdown source and select the text manually.
        </p>
      ) : null}
      {view === 'preview' ? (
        <MarkdownPreview
          markdown={markdown || 'Loading extracted text…'}
          colorScheme={colorScheme}
          loadExternalImages={loadExternalImages}
        />
      ) : (
        <pre class="markdown-source" dir="auto">
          {markdown || 'Loading extracted text…'}
        </pre>
      )}
    </section>
  );
};
