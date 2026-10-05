/* 薬学てらこやの宿題 — オフライン用 Service Worker
 *
 * ねらい：スマホの通信量を使わないこと。
 *   1回目だけ本体をダウンロードして端末に保存し、2回目以降は通信なしで開く。
 *   更新の有無は version.json（約60バイト）だけで判定し、
 *   新しい版があるときに限って本体を取り直す。
 *   取り込んだ新版は「次にアプリを開いたとき」に出る。
 *   解いている最中に画面が差し替わらないよう、その場では切り替えない。
 */
var CACHE = 'terakoya';
var META = './__meta';                 // 最終確認時刻と版を入れておく疑似エントリ
var CHECK_INTERVAL = 6 * 3600 * 1000;  // 更新確認は最大6時間に1回

var CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon-32.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(CORE); })
      .then(function () { return rememberVersion(); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () { return self.skipWaiting(); })
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

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 別サイト（スプレッドシートへの送信など）には一切手を出さない
  if (url.origin !== self.location.origin) return;

  e.respondWith(serve(req));
  e.waitUntil(checkUpdate());
});

/* キャッシュにあればそれを返す。無ければ取りに行って保存する。 */
function serve(req) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          cache.put(req, res.clone()).catch(function () {});
        }
        return res;
      });
    });
  });
}

function readMeta(cache) {
  return cache.match(META).then(function (r) {
    if (!r) return {};
    return r.json().catch(function () { return {}; });
  });
}

function writeMeta(cache, m) {
  return cache.put(META, new Response(JSON.stringify(m), {
    headers: { 'Content-Type': 'application/json' }
  })).catch(function () {});
}

function fetchVersion() {
  return fetch('./version.json?_=' + Date.now(), { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { return j && j.version ? j.version : null; })
    .catch(function () { return null; });   // オフラインなら何もしない
}

/* インストール直後に、いま持っている版を記録しておく */
function rememberVersion() {
  return caches.open(CACHE).then(function (cache) {
    return fetchVersion().then(function (v) {
      return writeMeta(cache, { version: v, checkedAt: Date.now() });
    });
  });
}

/* 更新確認。版が変わっていたときだけ本体を取り直す。
 * ページとマニフェストで fetch が2回起きるため、同時に走らないよう1本にまとめる。
 * これをしないと、更新のあった回に本体を二重にダウンロードしてしまう。 */
var _updating = null;
function checkUpdate() {
  if (_updating) return _updating;
  _updating = doCheckUpdate()
    .catch(function () {})
    .then(function () { _updating = null; });
  return _updating;
}

function doCheckUpdate() {
  return caches.open(CACHE).then(function (cache) {
    return readMeta(cache).then(function (meta) {
      var now = Date.now();
      if (meta.checkedAt && (now - meta.checkedAt) < CHECK_INTERVAL) return;

      return fetchVersion().then(function (v) {
        if (!v) return;                       // 取れなければ記録も残さず次回また確認
        meta.checkedAt = now;
        if (meta.version === v) return writeMeta(cache, meta);

        // 新しい版があるので本体を取り直す
        return fetch('./index.html?_=' + now, { cache: 'no-store' })
          .then(function (res) {
            if (!res || !res.ok) return;
            return cache.put('./index.html', res.clone())
              .then(function () { return cache.put('./', res.clone()); })
              .then(function () { meta.version = v; });
          })
          .catch(function () {})
          .then(function () { return writeMeta(cache, meta); });
      });
    });
  }).catch(function () {});
}
