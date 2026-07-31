import { defineConfig } from 'vitest/config';

/**
 * `globalSetup` 喺所有測試檔之前 build 一次。
 *
 * 有幾個測試檔（pwa、privacy、browser）都要讀 `dist/`。如果各自
 * 「見到冇就 build」，vitest 並行跑嗰陣就會有兩個 `vite build` 同時
 * 清空同一個 `dist/` —— 出嚟嘅失敗會飄忽又難查。統一喺呢度 build
 * 一次，測試檔淨係負責讀。
 */
export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
  },
});
