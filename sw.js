/* Service worker del portal de juegos.
   Hace que los juegos se abran sin conexión: cachea la portada, los HTML de
   cada juego, las imágenes y las dependencias externas (Tone.js y la fuente
   Press Start 2P).

   IMPORTANTE: este archivo tiene que estar en la RAÍZ del repositorio, al lado
   de index.html. Un service worker solo controla las páginas que cuelgan de su
   propia carpeta, así que si se sube dentro de webs/ no vería ni images/ ni la
   portada, y la descarga sin conexión no serviría de nada. */

var VERSION = 'v3';
var CACHE = 'juegos-' + VERSION;

/* Lo mínimo para que la portada abra sin conexión. Se cachea solo al instalar,
   que es rápido y no gasta datos del usuario sin avisar. Los juegos se
   descargan con el botón "Descargar sin conexión". */
var SHELL = [
  './',
  './index.html',
  './manifest.json',
  './images/icono-192.png',
  './images/icono-512.png',
  './images/apple-touch-icon.png'
];

/* Dependencias externas de los juegos. Si no se cachean, el Quiz se queda sin
   sonido y el Quiz y el Tetris pierden su tipografía al abrirlos sin cobertura. */
var EXTERNOS = [
  'https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.min.js',
  'https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap'
];

function esFuenteCSS(url) {
  return url.indexOf('fonts.googleapis.com/css') !== -1;
}

function esExterno(url) {
  return url.indexOf(self.location.origin) !== 0;
}

function esHTML(req) {
  return req.mode === 'navigate' ||
         (req.headers.get('accept') || '').indexOf('text/html') !== -1;
}

/* ------------------------------------------------------------------
   INSTALACIÓN
   ------------------------------------------------------------------ */
/* addAll() es atómico: si UNO solo de los archivos da 404, falla la lista
   entera y no se guarda nada. Con una lista larga (y con juegos "en
   desarrollo" que aún no existen) eso es casi seguro, así que se cachea
   archivo a archivo tolerando fallos individuales. */
function cachearTolerante(cache, urls) {
  return Promise.all(urls.map(function (u) {
    return cache.add(new Request(u, { cache: 'reload' })).catch(function () {
      return null;   // este archivo no está disponible; el resto sigue
    });
  }));
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return cachearTolerante(c, SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === CACHE ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* ------------------------------------------------------------------
   GUARDADO EN CACHÉ
   ------------------------------------------------------------------ */
function guardar(req, res) {
  if (!res) return res;
  if (!(res.ok || res.type === 'opaque')) return res;

  var copia = res.clone();
  caches.open(CACHE).then(function (c) {
    return c.put(req, copia);
  }).catch(function () {});

  return res;
}

/* ------------------------------------------------------------------
   ESTRATEGIAS DE RED
   ------------------------------------------------------------------ */

/* Red primero: para los HTML. Así, cuando subas una versión nueva de un juego
   al repositorio, el jugador la recibe en cuanto tenga cobertura en lugar de
   quedarse con la copia antigua para siempre. */
function redPrimero(req) {
  /* `cache: 'reload'` salta la caché HTTP del navegador.
     Sin esto, GitHub Pages sirve los HTML con Cache-Control: max-age=600, así
     que durante diez minutos el propio navegador devolvía su copia antigua sin
     llegar a preguntar al servidor: se subía una corrección al repositorio y el
     jugador seguía viendo la versión de antes aunque tuviera cobertura.
     Para las peticiones de navegación no se puede reutilizar el Request (su
     modo no se puede reconstruir), así que se pide por URL. */
  var peticion;
  try {
    peticion = new Request(req.url, { cache: 'reload', credentials: 'same-origin' });
  } catch (err) {
    peticion = req;
  }

  return fetch(peticion)
    .then(function (r) { return guardar(req, r); })
    .catch(function () {
      return caches.match(req).then(function (m) {
        if (m) return m;
        /* Navegación a algo que no tenemos: se devuelve la portada, que sí
           está cacheada, en lugar del error del navegador.
           OJO: no vale `caches.match(a) || caches.match(b)`, porque match()
           devuelve una promesa y una promesa SIEMPRE es verdadera, así que la
           segunda opción nunca llegaría a evaluarse y el resultado sería
           `undefined`. Hay que encadenar los then. */
        return caches.match('./index.html')
          .then(function (p) { return p || caches.match('./'); })
          .then(function (p) {
            if (p) return p;
            return new Response(
              '<!DOCTYPE html><meta charset="utf-8"><title>Sin conexión</title>' +
              '<body style="background:#0f0c2d;color:#fff;font-family:system-ui;' +
              'display:grid;place-items:center;height:100vh;margin:0;text-align:center">' +
              '<div><h1>Sin conexión</h1><p>Este contenido no está descargado.</p></div>',
              { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            );
          });
      });
    });
}

/* Caché primero: para lo que no cambia (imágenes, fuentes, Tone.js). Es lo que
   da la sensación de apertura instantánea. */
function cachePrimero(req) {
  return caches.match(req).then(function (m) {
    if (m) return m;
    return fetch(req)
      .then(function (r) { return guardar(req, r); })
      .catch(function () { return undefined; });
  });
}

/* Caché primero pero refrescando por detrás: sirve la copia guardada al
   instante y actualiza en segundo plano para la próxima vez. */
function cacheYRefresco(req) {
  return caches.match(req).then(function (m) {
    var red = fetch(req)
      .then(function (r) { return guardar(req, r); })
      .catch(function () { return m; });
    return m || red;
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = req.url;
  if (url.indexOf('chrome-extension') === 0) return;
  if (url.indexOf('http') !== 0) return;

  /* Los HTML (portada y juegos): red primero para recoger actualizaciones. */
  if (esHTML(req)) {
    e.respondWith(redPrimero(req));
    return;
  }

  /* Fuentes y librerías externas: nunca cambian para una misma URL. */
  if (esExterno(url)) {
    e.respondWith(cachePrimero(req));
    return;
  }

  /* Imágenes y demás del propio repositorio. */
  e.respondWith(cacheYRefresco(req));
});

/* ------------------------------------------------------------------
   MENSAJES DESDE LA PÁGINA
   ------------------------------------------------------------------ */

/* La hoja de estilos de Google Fonts no contiene la fuente: contiene enlaces a
   los .woff2 reales. Si solo se cachea el CSS, sin conexión el navegador pide
   un archivo que no tiene y se cae a la fuente del sistema. Aquí se lee el CSS
   y se extraen esas URL para cachearlas también. */
function expandirFuente(cssUrl) {
  return fetch(cssUrl, { cache: 'reload' })
    .then(function (r) {
      if (!r || !r.ok) return [];
      return caches.open(CACHE).then(function (c) {
        return c.put(cssUrl, r.clone()).then(function () { return r.text(); });
      });
    })
    .then(function (texto) {
      if (!texto) return [];
      var urls = [];
      var re = /url\((https:\/\/[^)]+)\)/g;
      var m;
      while ((m = re.exec(texto)) !== null) urls.push(m[1]);
      return urls;
    })
    .catch(function () { return []; });
}

function precargar(urls, port) {
  return caches.open(CACHE).then(function (c) {
    /* Primero se expanden las hojas de Google Fonts en sus archivos de fuente */
    var extras = urls.filter(esFuenteCSS).map(expandirFuente);

    return Promise.all(extras).then(function (listas) {
      var todas = urls.slice();
      listas.forEach(function (l) { todas = todas.concat(l); });

      /* Sin duplicados: varias páginas comparten la misma fuente */
      var vistas = {};
      todas = todas.filter(function (u) {
        if (vistas[u]) return false;
        vistas[u] = true;
        return true;
      });

      var hechas = 0;
      var total = todas.length;
      var fallos = [];

      return Promise.all(todas.map(function (u) {
        /* cache:'reload' evita que se guarde una copia rancia del navegador */
        return fetch(new Request(u, { cache: 'reload' }))
          .then(function (r) {
            if (r && (r.ok || r.type === 'opaque')) return c.put(u, r);
            fallos.push(u);
          })
          .catch(function () { fallos.push(u); })
          .then(function () {
            hechas++;
            if (port) port.postMessage({ done: hechas, total: total });
          });
      })).then(function () {
        return { total: total, fallos: fallos };
      });
    });
  });
}

function estado(urls) {
  return caches.open(CACHE).then(function (c) {
    var guardadas = 0;
    return Promise.all(urls.map(function (u) {
      return c.match(u).then(function (m) { if (m) guardadas++; });
    })).then(function () {
      return { cached: guardadas, total: urls.length };
    });
  });
}

self.addEventListener('message', function (e) {
  var data = e.data || {};
  var port = e.ports && e.ports[0];

  if (data.type === 'PRECACHE' && Array.isArray(data.urls)) {
    e.waitUntil(
      precargar(data.urls, port).then(function (res) {
        if (port) port.postMessage({
          finished: true,
          total: res.total,
          failed: res.fallos.length,
          failedUrls: res.fallos
        });
      }).catch(function (err) {
        if (port) port.postMessage({ finished: true, error: String(err) });
      })
    );
    return;
  }

  if (data.type === 'STATUS' && Array.isArray(data.urls)) {
    e.waitUntil(
      estado(data.urls).then(function (r) {
        if (port) port.postMessage(r);
      })
    );
    return;
  }

  if (data.type === 'CLEAR') {
    e.waitUntil(
      caches.delete(CACHE).then(function () {
        if (port) port.postMessage({ cleared: true });
      })
    );
    return;
  }

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
