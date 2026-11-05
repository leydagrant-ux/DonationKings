/* sw.js: service worker.
 *
 * BUMP `VERSION` ON EVERY DEPLOY. Without a bump the old shell is served from
 * cache and your changes silently do not appear on anybody's phone.
 *
 * `SHELL` MUST list every module index.html imports, directly or indirectly.
 * index.html is a type="module", so a file missing from this list is not a
 * degraded app, it is a BLANK app: the import chain dies and nothing renders.
 * After any deploy that touches the module list, fetch each file from the live
 * site to confirm it is really there.
 *
 * This follows the LockIN worker rather than the bankroll one. Bankroll
 * registered once on load and nothing else, so an installed app ran stale
 * JavaScript for days and nine release notes had to say "remove it from the
 * Home Screen and re-add it". The fix is checking for an update on launch AND
 * on every return to foreground, which index.html does.
 */

const VERSION = 'v1.0.7';
const CACHE = `donationkings-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './dk/theme.css',
  './dk/app.js',
  './dk/backend.js',
  './dk/api.js',
  './dk/auth.js',
  './dk/config.js',
  './dk/store.js',
  './dk/feed.js',
  './dk/derive.js',
  './dk/espn.js',
  './dk/resolve.js',
  './dk/grade.js',
  './dk/parlay.js',
  './dk/odds.js',
  './dk/league.js',
  './dk/slip.js',
  './dk/stats.js',
  './dk/ingest.js',
  './dk/ui.js',
  './dk/ui-league.js',
  './dk/ui-entry.js',
  './dk/ui-stats.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /* Individually, not addAll: addAll rejects the whole install if any one
       file 404s, which would leave the app with no service worker at all. */
    await Promise.allSettled(SHELL.map((url) => cache.add(url)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* The page asks what version is actually running. Reporting it from here keeps
   ONE source of truth: a copy of the number in the app would drift the first
   time only one of the two got bumped. */
self.addEventListener('message', (event) => {
  if (event.data === 'version') event.source?.postMessage({ swVersion: VERSION });
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /* Never touch Firebase, the Worker, or the score feed. A stale standings
     table or a stale box score would be worse than failing: this app's whole
     job is telling you what is true right now. */
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    /* Network first for the app shell, so a deploy is picked up as soon as the
       phone has signal, falling back to cache when it does not. */
    try {
      const fresh = await fetch(request);
      if (fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(request, fresh.clone());
      }
      return fresh;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      /* A navigation with no cache entry still needs to render something. */
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw new Error('offline and not cached');
    }
  })());
});
