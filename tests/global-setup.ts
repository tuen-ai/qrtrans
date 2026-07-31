import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/**
 * 喺所有測試之前 build 一次，令依賴 `dist/` 嘅測試有嘢可讀。
 *
 * **一定要明確設 `NODE_ENV=production`。** Vitest 會將 `NODE_ENV` 設成
 * `'test'`，而 Vite 就係睇 `NODE_ENV` 嚟決定係咪 production build ——
 * 唔覆寫嘅話 `import.meta.env.DEV` 會變 `true`，於是所有 `if (DEV) return`
 * 嘅程式碼（例如 service worker 註冊）就會喺產物入面被消除。
 *
 * 咁樣測試就會喺度測一個同真正部署**唔同**嘅產物 —— 一種好難察覺、
 * 而且會令人查極都查唔到嘅假象。
 */
export function setup(): void {
  execFileSync('npx', ['vite', 'build'], {
    cwd: REPO,
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  });
}
