// ============================================================
// sw.js — Service Worker（アプリ本体一式をキャッシュしオフライン起動を可能にする）
// 要件定義書§4「アプリ本体はオフラインでも起動できること」を実装。
// 注意：Service Worker は http(s) 配信下でのみ有効（file:// では登録自体がブラウザに拒否される。
//       その場合は app.js が登録失敗を握りつぶし、通常のfile://読み込みで動作継続する）。
// キャッシュ対象はアプリ「殻」のみ（送信先URL・マスターデータ・記録内容はキャッシュしない＝localStorage側の責務）。
// ============================================================

const CACHE_NAME = 'zoshi-output-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/core.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; })
          .map(function (n) { return caches.delete(n); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// ネットワークファースト（アプリ殻）。オンラインなら常に最新を取得しキャッシュを更新、
// オフライン時のみキャッシュから返す。これにより「コード更新が反映されない」問題を防ぎつつ、
// オフライン起動（要件§4）も維持する。
// マスター取得(doGet)・記録送信(doPost)などブリッジ宛（別オリジン）は intercept せず素通り。
self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return; // POSTは素通し
  if (new URL(req.url).origin !== self.location.origin) return; // 外部オリジンは素通し

  event.respondWith(
    // ⚠ cache:'reload' でブラウザHTTPキャッシュを迂回し、常にサーバー最新を取得する
    //   （古いHTTPキャッシュが残ってコード更新が反映されない問題への対策）。
    fetch(req, { cache: 'reload' }).then(function (res) {
      if (res && res.ok) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(req, clone); });
      }
      return res;
    }).catch(function () {
      // オフライン：キャッシュから返す。navigateはindex.htmlへフォールバック。
      return caches.match(req).then(function (cached) {
        if (cached) return cached;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return undefined;
      });
    })
  );
});
