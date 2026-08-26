/**
 * Service worker : coquille hors ligne + réception d'un PDF partagé depuis
 * Android. Le PDF n'est jamais transmis nulle part — il transite par un cache
 * local, le temps que la page le récupère.
 */
const VERSION = 'v1';
const CACHE = `pdf2agenda-${VERSION}`;
const CACHE_PARTAGE = 'pdf2agenda-partage';

const COQUILLE = [
  './', './index.html', './styles.css', './app.js', './parse.js',
  './codes.js', './gcal.js', './store.js', './manifest.webmanifest',
  './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(COQUILLE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((noms) => Promise.all(
        noms.filter((n) => n.startsWith('pdf2agenda-') && n !== CACHE && n !== CACHE_PARTAGE)
            .map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Partage Android : on met le fichier de côté et on renvoie la page.
  if (e.request.method === 'POST' && url.pathname.endsWith('/partage')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const fichier = form.get('fichier');
        if (fichier) {
          const cache = await caches.open(CACHE_PARTAGE);
          await cache.put('fichier', new Response(fichier, {
            headers: {
              'Content-Type': fichier.type || 'application/pdf',
              'x-nom': fichier.name || 'planning.pdf',
            },
          }));
        }
      } catch { /* on redirige quand même : l'utilisateur pourra déposer le PDF */ }
      return Response.redirect('./?partage=1', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET') return;
  // La bibliothèque Google d'authentification doit toujours venir du réseau.
  if (url.origin !== self.location.origin) return;

  // Les dépendances figées (pdf.js, icônes) viennent du cache : elles ne
  // changent qu'avec leur version, et ce sont les plus lourdes.
  const fige = /\/(vendor|icons)\//.test(url.pathname);

  const enCache = (reponse) => {
    if (reponse.ok && reponse.type === 'basic') {
      const copie = reponse.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copie)).catch(() => {});
    }
    return reponse;
  };

  if (fige) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then(enCache)),
    );
    return;
  }

  // Le reste — page, scripts, styles — est demandé au réseau d'abord, pour
  // qu'une mise à jour publiée soit visible au rechargement suivant sans avoir
  // à vider quoi que ce soit. Le cache prend le relais hors ligne.
  e.respondWith(
    fetch(e.request)
      .then(enCache)
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html'))),
  );
});
