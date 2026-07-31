/// <reference lib="webworker" />

/**
 * Service worker —— 令 app 裝得落機同埋完全離線行得到。
 *
 * 點解手寫而唔用 Workbox：service worker 係整個 app 入面**唯一**可以
 * 攔截所有網絡請求嘅嘢。呢個專案有「檔案永遠唔會離開部機」嘅硬性要求，
 * 所以嗰段程式碼必須夠短、夠明、審得晒。呢度就係全部：
 *
 *  - 淨係處理**同源 GET**。其他一律唔理，直接交返畀瀏覽器
 *  - 只從 cache 讀或者向自己個 origin 攞，**永遠唔會送任何嘢出街**
 *  - 唔會讀請求／回應嘅內容，唔會記錄，唔會轉發
 *
 * 快取策略：
 *  - 帶 hash 嘅資源（assets/…）內容永遠唔變 → cache-first，慳返網絡
 *  - 導覽請求 → 先試網絡（攞到最新版），失敗就返 cache 入面嘅 app shell。
 *    咁樣離線／飛行模式一樣開得到
 *
 * 更新策略：**唔用 skipWaiting**。呢點好緊要 —— app 會喺用戶按「開始播放」
 * 嗰陣先至去 load worker 同 1MB 嘅 wasm（都係帶 hash 嘅檔名）。如果喺頁面
 * 行緊嗰陣強行換咗新版 SW 兼清走舊 cache，嗰啲舊 hash 就會 404，傳輸即刻
 * 爆。所以等所有分頁閂晒先切版本。
 */

// 用一個 typed 別名而唔係 `declare const self` —— 後者會同 lib.dom 嘅
// 全域 `self` 撞，而且會逼呢個檔案變成 module（多咗 import/export 就唔
// 再係一個乾淨嘅 classic service worker script）
const sw = self as unknown as ServiceWorkerGlobalScope;

/** build 時由 Vite 插件填入：所有要預先快取嘅檔案（相對 SW 位置）。 */
const PRECACHE: string[] = JSON.parse('__PRECACHE_MANIFEST__');
/** build 時由 Vite 插件填入：資源清單嘅 hash，內容一變就換 cache。 */
const CACHE_NAME = 'qrtrans-__CACHE_VERSION__';

/** 將相對路徑解析成絕對 URL（SW 嘅 scope 就係 app 嘅根）。 */
function resolve(path: string): string {
  return new URL(path, sw.registration.scope).href;
}

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // 逐個加：一個檔案失敗唔應該令成個安裝失敗
      await Promise.all(
        PRECACHE.map(async (path) => {
          try {
            await cache.add(new Request(resolve(path), { cache: 'reload' }));
          } catch {
            // 靜靜跳過；行時 fetch handler 會有 network 後備
          }
        }),
      );
    })(),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 行到呢度即係所有用緊舊版嘅分頁都已經閂咗，清走舊 cache 係安全嘅
      const names = await caches.keys();
      await Promise.all(
        names.map((name) =>
          name.startsWith('qrtrans-') && name !== CACHE_NAME ? caches.delete(name) : undefined,
        ),
      );
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('fetch', (event) => {
  const request = event.request;

  // 只理同源 GET。跨域嘅嘢我哋根本冇（CSP 都擋住），
  // 但明確唔掂佢會令呢個 SW 嘅職責範圍清清楚楚
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;

  // 導覽：網絡優先（拎到最新版），失敗就用 cache 入面嘅 app shell
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(CACHE_NAME);
          const shell = await cache.match(resolve('index.html'));
          if (shell) return shell;
          return new Response('離線，而且未快取到 app。請連一次網再試。', {
            status: 503,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        }
      })(),
    );
    return;
  }

  // 其他資源：cache 優先。帶 hash 嘅檔名內容唔會變，所以唔使再驗
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;

      const response = await fetch(request);
      // 順手補入 cache（例如舊版 SW 未見過嘅新資源）
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        void cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
