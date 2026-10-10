/* 薬学てらこやの宿題 — オフライン用 Service Worker
 *
 * ねらい：スマホの通信量を使わないこと。
 *   1回目だけ本体をダウンロードして端末に保存し、2回目以降は通信なしで開く。
 *   更新の有無は version.json（約60バイト）だけで判定し、
 *   新しい版があるときに限って本体を取り直す。
 *   取り込んだ新版は「次にアプリを開いたとき」に出る。
 *   解いている最中に画面が差し替わらないよう、その場では切り替えない。
 *
 * v6.11：更新の確認を「アプリを開くたび・画面に戻るたび」にした（以前は最大6時間に1回）。
 *   ホーム画面に追加したアプリは裏から戻るだけでは読み直されないため、
 *   ページから 'check' を送ってもらい、確認の結果（いま保存している版）を返す。
 *   ページは自分の版と違えば「新しい版があります（タップで更新）」を出す。
 *   確認は1分以内の連続を間引くだけで、通信は version.json（約60バイト）のみ。
 */
var CACHE = 'terakoya';
var META = './__meta';                 // 最終確認時刻と版を入れておく疑似エントリ
var CHECK_INTERVAL = 60 * 1000;         // 連続した確認を1分間だけ間引く（v6.11。以前は6時間）

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

  // 版の確認用ファイルはキャッシュしない。
  // Service Worker 自身の更新確認は影響を受けないが、ブラウザで直接開いたときに
  // 古い値が返って紛らわしいため、常にネットワークから取る。
  if (url.pathname.indexOf('version.json') >= 0) return;

  // 教材（/textbook/）はこのアプリとは別物。画像が大きいので抱え込まない。
  // ブラウザふつうのキャッシュにまかせる。
  if (url.pathname.indexOf('/textbook/') >= 0) return;

  e.respondWith(serve(req));
  e.waitUntil(checkUpdate());
});

/* ページからの確認依頼（開いたとき・画面に戻ったとき）。確認後、保存している版を返す */
self.addEventListener('message', function (e) {
  if (e.data !== 'check') return;
  var src = e.source;
  e.waitUntil(checkUpdate().then(function () {
    return caches.open(CACHE).then(readMeta).then(function (meta) {
      if (src && meta && meta.version) src.postMessage({ type: 'ver', version: meta.version });
    });
  }).catch(function () {}));
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

        // 新しい版があるので本体を取り直す。
        // 公開直後は version.json だけ先に新しくなり、本体がまだ古いことがある（配信の反映待ち）。
        // そのまま保存すると「古い本体を新しい版として」覚えてしまい、次の版まで更新されなくなる。
        // 取ってきた本体に同じ版数（APP_VER）が書かれているときだけ保存し、
        // 違えば何も保存せず、次に開いたときにもう一度確認する。
        return fetch('./index.html?_=' + now, { cache: 'no-store' })
          .then(function (res) {
            if (!res || !res.ok) return;
            return res.clone().text().then(function (html) {
              if (html.indexOf('APP_VER = "' + v + '"') < 0) { meta.checkedAt = 0; return; }
              return cache.put('./index.html', res.clone())
                .then(function () { return cache.put('./', res.clone()); })
                .then(function () { meta.version = v; });
            });
          })
          .catch(function () {})
          .then(function () { return writeMeta(cache, meta); });
      });
    });
  }).catch(function () {});
}
