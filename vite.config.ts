import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

/** 遞迴列出 `public/` 入面所有檔案（相對 public 嘅路徑）。 */
function listPublicFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listPublicFiles(full, base));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

/**
 * 將 `src/sw.ts` build 成一個唔帶 hash 嘅 `sw.js`，並且填入 precache 清單。
 *
 * Service worker 嘅檔名一定要**穩定**（唔可以帶 hash）：瀏覽器係靠同一條
 * URL 去認返「同一個 SW」先知有冇更新。至於要 precache 邊啲檔案，就要
 * 等到 build 尾聲、所有帶 hash 嘅檔名都定咗之後先知，所以喺 `generateBundle`
 * 階段先填入去。
 */
function serviceWorker(): Plugin {
  return {
    name: 'qrtrans:service-worker',
    apply: 'build',
    // 一定要 post：Vite 內建嘅 HTML 插件都係喺 generateBundle 先 emit
    // index.html，早過佢行嘅話 app shell 就唔會入到 precache 清單，
    // 離線開頁面會 503
    enforce: 'post',
    buildStart() {
      this.emitFile({
        type: 'chunk',
        id: join(ROOT, 'src/sw.ts'),
        fileName: 'sw.js',
      });
    },
    generateBundle(_options, bundle) {
      const chunk = bundle['sw.js'];
      if (!chunk || chunk.type !== 'chunk') {
        this.error('搵唔到 sw.js chunk —— service worker build 唔到');
        return;
      }

      // rollup 產出嘅嘢（index.html、assets/*.js、*.css、*.wasm）
      const bundled = Object.keys(bundle).filter((f) => f !== 'sw.js' && !f.endsWith('.map'));
      // public/ 入面嘅嘢係 Vite 直接抄過去嘅，唔會出現喺 bundle 度
      const publicFiles = listPublicFiles(join(ROOT, 'public'));
      const precache = [...new Set([...bundled, ...publicFiles])].sort();

      // app shell 冇咗就冇離線能力，靜靜雞漏咗好難察覺，所以喺度截住
      if (!precache.includes('index.html')) {
        this.error('precache 清單入面冇 index.html —— 離線就開唔到頁面');
        return;
      }

      // 版本 = 清單 + public 檔案內容嘅 hash。帶 hash 嘅資源改咗內容檔名就會變，
      // 但 public/ 嘅檔名係固定嘅，所以要連內容一齊計，否則改咗 icon 都唔會換 cache
      const hasher = createHash('sha256').update(precache.join('\n'));
      for (const file of publicFiles) hasher.update(readFileSync(join(ROOT, 'public', file)));
      const version = hasher.digest('hex').slice(0, 12);

      // 唔可以寫死引號款式：minifier 會將單引號轉做雙引號，
      // 寫死就會靜靜雞取代唔到，出街嘅 SW precache 一個檔案都冇
      const before = chunk.code;
      chunk.code = before
        .replace(/(['"])__PRECACHE_MANIFEST__\1/, JSON.stringify(JSON.stringify(precache)))
        .replace('__CACHE_VERSION__', version);

      if (chunk.code.includes('__PRECACHE_MANIFEST__') || chunk.code.includes('__CACHE_VERSION__')) {
        this.error('service worker 嘅 placeholder 取代唔到 —— sw.js 出唔到街');
        return;
      }

      this.info(`service worker：precache ${precache.length} 個檔案，版本 ${version}`);
    },
  };
}

/**
 * 喺 build 產物層面物理性廢除任何 CDN 後備路徑。
 *
 * `zxing-wasm` 內建一個預設 `locateFile`，會去 jsDelivr 攞 wasm。
 * 我哋喺 decode.worker.ts 覆寫咗佢指去自我托管嘅檔案，而 CSP 亦都
 * 會擋住外部請求 —— 但「應該行唔到嗰度」唔係一個好嘅私隱保證。
 *
 * 呢個插件將 CDN 主機名改成一個唔存在嘅 scheme，令就算有人日後
 * 唔小心搞爛咗覆寫，結果都係**即刻失敗**而唔係靜靜雞出街攞嘢。
 */
function forbidCdnFallbacks(): Plugin {
  const hosts = [
    'https://fastly.jsdelivr.net',
    'https://cdn.jsdelivr.net',
    'https://unpkg.com',
  ];
  return {
    name: 'qrtrans:forbid-cdn-fallbacks',
    apply: 'build',
    enforce: 'post',
    renderChunk(code) {
      let out = code;
      for (const host of hosts) {
        out = out.split(host).join('qrtrans-cdn-disabled://blocked');
      }
      return out === code ? null : { code: out, map: null };
    },
  };
}

/**
 * `base` 用相對路徑，令 build 出嚟嘅檔案喺 GitHub Pages 嘅
 * `/<repo>/` 子路徑下面都行得，唔使寫死 repo 名。
 *
 * dev server 行 HTTPS：手機要用鏡頭就一定要 secure context，
 * 而 `localhost` 例外唔適用於區網 IP。
 */
export default defineConfig({
  base: './',
  plugins: [basicSsl(), forbidCdnFallbacks(), serviceWorker()],
  server: {
    host: true, // 綁 0.0.0.0，手機喺同一個 Wi-Fi 下就連得到
    port: 5173,
  },
  build: {
    target: 'es2022',
    // wasm 唔好被 inline 成 base64 —— 咁樣會令 JS bundle 爆大，
    // 而且失去 streaming compile。同時保證佢係一個獨立嘅同源檔案，
    // 唔會走去 CDN 攞
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
    // worker 係獨立一條 build 管線，插件要另外掛一次
    plugins: () => [forbidCdnFallbacks()],
  },
});
