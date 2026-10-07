/**
 * Resolve an application URL against the directory that served the UI.
 *
 * NodeRag is served at `/` in the local testbed and through an alias such as
 * `/noderag/` on DSM. Root-relative browser URLs bypass that alias, so all
 * application-owned routes must retain the current mount directory.
 */
export const resolveAppUrl = (path: string, pageHref: string): string => {
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//')) return path;
  const base = new URL('./', pageHref);
  return new URL(path.replace(/^\/+/, ''), base).toString();
};

export const appUrl = (path: string): string => resolveAppUrl(path, window.location.href);
