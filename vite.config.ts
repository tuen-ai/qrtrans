import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * `base` 用相對路徑，令 build 出嚟嘅檔案喺 GitHub Pages 嘅
 * `/<repo>/` 子路徑下面都行得，唔使寫死 repo 名。
 *
 * dev server 行 HTTPS：手機要用鏡頭就一定要 secure context，
 * 而 `localhost` 例外唔適用於區網 IP。
 */
export default defineConfig({
  base: './',
  plugins: [basicSsl()],
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
  },
});
