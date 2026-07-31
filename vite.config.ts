import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

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
  plugins: [basicSsl(), forbidCdnFallbacks()],
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
