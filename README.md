# QRTRANS — 閃爍 QR 離線檔案傳輸

用快速閃爍嘅二維碼喺兩部裝置之間傳檔案。**唔使網絡、唔使藍牙、唔使配對** ——
一邊播、一邊用鏡頭掃，資料就係咁樣經光傳過去。

```
[電腦網頁]  檔案 → gzip → 切 block → fountain 編碼 → 逐幀畫成 QR ▓▒░▓▒░
                                                              ↓ 光
[手機鏡頭]  掃描 → 解 QR → fountain 解碼 → gunzip → 驗 SHA-256 → 下載
```

雙向嘅：兩邊都可以做發送端或者接收端。

**可以裝落主畫面**，裝咗之後連載入 app 都唔使上網 —— 真正嘅完全離線。

---

## 🔒 私隱

**你揀嘅檔案永遠唔會離開你部裝置。**

呢個唔係一句宣傳，係整個架構嘅約束，而且有自動化測試守住：

| 保證 | 點樣做到 |
|---|---|
| 零後端 | 純靜態網頁。冇 API、冇伺服器、冇資料庫 |
| 零網絡請求 | 原始碼入面完全冇 `fetch` / `XHR` / `WebSocket` / `sendBeacon` |
| 零第三方 | QR 解碼用嘅 wasm 自我托管，唔行 CDN。冇字型、冇 analytics、冇 error reporting |
| CSP 鎖死 | `connect-src 'self'` 令外送請求由瀏覽器層面擋住；`img-src` 亦都唔放行外部網域，連 CSS 都做唔到外送通道 |
| 產物層面阻斷 | build 時將依賴內建嘅 CDN 後備網址改成無效 scheme —— 就算覆寫被搞爛，結果都係即刻失敗而唔係靜靜雞出街 |

GitHub Pages 只係 host 程式碼（程式碼本身係公開嘅）。檔案內容只存在於瀏覽器記憶體同螢幕像素。

> 傳輸靠光學空氣間隙。只要冇人喺你隔籬用相機影住個畫面，內容本身就係私密嘅。

驗證方法：

```bash
npm test          # 私隱測試 + 真瀏覽器全程監聽網絡請求，斷言零外部請求
```

Service worker 亦都受同一套約束：佢係整個 app 入面唯一可以攔截所有請求嘅嘢，
所以係手寫嘅（唔用 Workbox），只有幾十行，而且有測試守住佢**只准同源 GET**。

自己再確認一次：開 DevTools 的 Network 面板，全程傳一個檔案 —— 除咗最初載入 app 同 wasm，應該一個請求都冇。

---

## 用法

1. **電腦**開網頁 → 「發送」→ 揀檔案 → 開始播放
2. **手機**開同一條網址 → 「接收」→ 開啟鏡頭 → 對正個閃緊嘅 QR
3. 收齊自動驗 SHA-256，然後下載

### 裝成 app

- **Android / Chrome / Edge**：頁面上面會出「安裝」掣，撳一下就得
- **iPhone / Safari**：分享 → 加入主畫面（iOS 冇安裝 API，只可以自己撳）
- **桌面 Chrome / Edge**：網址列右邊嘅安裝圖示

裝咗之後全部資源（連 1MB 嘅 QR 解碼 wasm）都會 precache 落機，
飛行模式一樣開得到、用得到。

### 揀啱設定

**最密嘅 QR 唔係最快。** 因為真正嘅硬底線係「每個模組要有 3 個相機像素」
（實測跌到 2 就係 0%，唔係差啲）。喺 1080p 鏡頭之下可用模組總數大約 324，
所以碼細啲、排多幾個，總吞吐反而高。1080p 實測：

| 組合 | 相機每模組 | 一次解到 | 單 worker 吞吐 |
|---|---|---|---|
| 極速 v40 單碼 | 5 px | 1/1 | 153 KB/s |
| **平衡 v27 2×2** | 3 px | 4/4 | **232 KB/s** ← 預設 |
| 穩陣 v20 3×3 | 3 px | 9/9 | 214 KB/s |
| 平衡 v27 3×3 | 2 px | **0/9** | 0 |
| 極速 v40 2×2 | 2 px | **0/4** | 0 |

發送頁面會按你揀嘅組合計出 1080p 鏡頭大約有幾多 px/模組，唔夠就會警告。

**幀率預設 30fps，而唔係 60fps。** LCD 有響應時間，連續幀會拖影 ——
60fps 但掉一半幀，比 30fps 全收到更慢。收唔到就調低，唔好調高。

其他貼士：螢幕亮度較高、熄咗自動亮度；維持成個 QR 連白邊都喺鏡頭畫面入面。
兩邊都會自動申請 Wake Lock，唔使驚傳到一半熄屏。

---

## 佢點解快得起嚟

### Fountain code（LT）而唔係循環重播

冇回傳通道 —— 發送端唔知接收端收到乜。傳統做法係由 block 0 播到 N 再由頭播，
掉咗一幀就要等成個 cycle。Fountain code 每一幀都係一個新嘅隨機組合，
接收端收夠**任何** ~1.1×K 個就砌得返，掉幀完全免疫。

實測（模擬相機掉幀）：

| 情況 | 總共要播 |
|---|---|
| 掉 20%，K=1000 | 1.46 × K 幀 |
| 掉 20%，K=3000 | 1.34 × K 幀 |
| 掉 35%，K=3000 | 1.64 × K 幀 |

同場實測過「先播一輪完整 block，再用 fountain 補漏」嘅方案：
只喺**零掉幀**時贏，喺真實嘅 20–40% 掉幀率之下反而慢 30–76%。所以維持純 LT。

Seed 就係一切：包入面只帶一個 4-byte seed，接收端用同一個 PRNG 推導返
呢個包 XOR 咗邊幾個 block —— index 清單唔使傳。

### 多碼並排

一個畫面排 N×N 個**完全獨立**嘅 fountain 包，接收端一次過解晒。
實測多符號解碼幾乎唔使額外時間（2×2 同 1×1 一樣快 24 vs 26 ms）——
即係四個碼一個價。

### 釘死 QR mask pattern

規格要求編碼器試晒 8 個 mask、逐個計罰分再揀最好 —— v40 即係
8 × 177² 次評估，佔咗編碼時間九成以上。任何 mask 都合法，而我哋嘅內容
係 fountain XOR 出嚟嘅近似隨機資料，本身就唔會出現 mask 想避開嘅大片
同色區。

| 檔位 | 自動揀 mask | 釘死 | 倍數 |
|---|---|---|---|
| 極速 v40-L | 30.7 ms/幀（33 fps 上限） | 2.3 ms（433 fps） | 13.3× |
| 平衡 v27-L | 14.2 ms（70 fps） | 1.0 ms（995 fps） | 14.1× |
| 穩陣 v20-M | 7.2 ms（139 fps） | 0.4 ms（2883 fps） | 20.7× |

代價量過：喺 3px/module + 模糊 + ±40 雜訊嘅邊緣條件下，8 個 mask 解碼率
都喺 96–98%，自動揀係 98%。即係最多蝕 2 個百分點 —— 而嗰 2% 正正就係
fountain code 免費吸收嘅嘢。

### 每個熱路徑都搬離主線程

- **發送**：fountain 產包 + QR 編碼喺 worker，維持 8 幀緩衝。主線程每幀只做一次 `drawImage`。可以開幾個 worker，各自負責 `frameIndex % workerCount === workerId` 嗰批 —— fountain 包獨立、次序無所謂，所以完全唔使協調
- **接收**：2–4 個解碼 worker 輪流食幀；全部忙就**直接掉幀唔排隊**（排隊只會令延遲愈滾愈大）
- **統計面板 250ms 節流** —— 每幀寫 DOM 會實測拖低 decode fps

### ROI 鎖定

一解到就記住 QR 喺畫面邊度，之後只解嗰一小舊，解碼速度翻幾倍。
連續 15 幀失敗就解鎖，返去掃全畫面。

### 唔起眼但好緊要嘅細節

- **QR 版本固定**，唔用 Auto —— 否則每幀大細會變，鏡頭不停重新對焦
- **canvas 邊長夾成模組數嘅整數倍** —— 冇 half-pixel 灰邊，二值化乾淨好多
- **二進位行 byte mode + ISO_8859_1** —— 當文字 UTF-8 編碼會令容量打對折兼搞爛資料，而 ISO_8859_1 係 QR 預設字集，唔會多出 ECI header 蝕位
- **讀 zxing 嘅 `.bytes` 而唔係 `.text`** —— 同上，`.text` 會做字集轉換
- **每幀有 CRC-32** —— QR 有 Reed-Solomon，但仍然有機會「成功解碼但內容錯」。一個壞包餵入 peeling 解碼器會靜靜雞污染一連串 block
- **DATA 幀自述** —— 每幀都帶 blockCount 同 payloadSize，接收端第一個解到嘅幀就開始砌，唔使等 manifest。blockSize 由幀長度推導返，唔使佔位
- **進度條數收到幾多幀，唔數解咗幾多 block** —— LT peeling 係後置爆發嘅，實測收到 75% 需要嘅幀先解出 1.9% block。用 block 數就會由頭到尾釘死喺 0% 再彈到 100%
- **iOS 相機要 `frameRate: {exact}`** —— 用 `ideal` 佢會靜靜雞畀返 30fps 而且唔報錯
- **rVFC 要 generation counter** —— 已排隊嘅 callback 會活過 `stop()` 並喺下一條 stream 復活，變成兩條 capture loop

---

## 開發

```bash
npm install
npm run dev -- --host      # HTTPS dev server，手機喺同一個 Wi-Fi 就連得到
npm test                   # 全部測試
npm run build              # 出 dist/
```

手機要用鏡頭一定要 secure context，所以 dev server 行 HTTPS（自簽證書，
手機第一次會問你信唔信）。

### 架構

```
src/
├─ protocol/     兩端共用嘅編碼核心 —— 呢度改壞咗兩邊就對唔上
│  ├─ prng.ts        SplitMix32（相鄰 seed 完全去相關）
│  ├─ soliton.ts     Robust Soliton + seed → block index 推導
│  ├─ lt-encoder.ts  無限噴泉
│  ├─ lt-decoder.ts  增量 peeling 解碼
│  ├─ frame.ts       MANIFEST / DATA 幀格式 + CRC
│  └─ crc32.ts, xor.ts
├─ codec/        File ↔ gzip ↔ SHA-256 ↔ manifest
├─ render/       qr-encode（編碼 + 檔位）、qr-painter、camera
├─ workers/      encode.worker（產包+編 QR）、decode.worker（zxing）
├─ ui/           sender、receiver、stats、install（PWA 安裝提示）
└─ sw.ts         service worker（precache 清單由 Vite 插件喺 build 時填入）
```

### 測試

89 個測試：

| 檔案 | 測乜 |
|---|---|
| `protocol.test.ts` | PRNG 決定性同均勻度、CRC 已知向量、**兩端 index 推導一致性**、幀格式逐 bit 翻轉 |
| `lt.test.ts` | LT 端到端：掉包 0–50%、亂序到達、隨機模糊測試、overhead 迴歸門檻 |
| `qr-roundtrip.test.ts` | 任意二進位 → QR → zxing → 一模一樣。滿載、全 0x00/0xFF、高位 byte、容量邊界、確認冇 ECI |
| `loopback.test.ts` | 真 File → gzip → fountain → QR 圖 → zxing → LT → gunzip → SHA-256，喺 25/30/50% 掉幀率下 |
| `browser.test.ts` | 真 Chromium：發送端幀率同零外部請求；**用假鏡頭（Y4M 影片）跑完整接收端**，連 `camera.ts`、ROI 鎖定、worker pool 都覆蓋；**2×2 多碼並排端到端**；**斷網之後重載 app 兼真係播到 QR** |
| `progress.test.ts` | 證明進度條真係線性推進、單調不減、完成一定到 100% |
| `camera.test.ts` | 用「故意唔理會 cancel」嘅假 video 測 rVFC 殭屍迴圈防護；相機約束階梯 |
| `encode-perf.test.ts` | QR 編碼速度迴歸門檻（防止有人改返去自動揀 mask） |
| `privacy.test.ts` | 私隱防線：唔准有外送 API、外部網域、CDN 殘留；CSP 內容；service worker 只准同源 |
| `pwa.test.ts` | manifest 欄位、圖示齊全、sw.js 檔名穩定、precache 涵蓋 worker 同 wasm、註冊碼真係喺產物入面 |

---

## 限制

- 建議 8 MB 以內。再大就播好耐，而且接收端會食唔少記憶體
- 需要 HTTPS 先用得鏡頭
- iPhone 請用 Safari。部分 app 內置瀏覽器（IG / FB / 微信）唔畀開鏡頭
- 冇加密。air gap 本身已經幾私密，但如果想防旁人偷影，可以將檔案自己先加密再傳
- 離線只係指「唔使網絡」——「發送」同「接收」始終要兩部機，一部播一部掃

## 靈感同致謝

概念參考 mrdoob 分享嘅 **DECIMEN — Fountain QR File Transfer**。

後來對照咗
[bashalarmistalt/decimen-optical-transfer](https://github.com/bashalarmistalt/decimen-optical-transfer)
嘅實作，佢哋 README 列嘅「hard-won details」好有價值，其中幾項直接令呢個
專案修正咗真問題：進度條要數收幀數、iOS 相機要 `exact` 幀率、rVFC 殭屍
迴圈、Wake Lock、釘死 mask pattern、自述式表頭。

有一項驗證後**唔適用**：佢哋為咗 `Math.log` 跨引擎差異手寫咗確定性 log。
嗰個問題源自佢哋直接攞 Float64 CDF 同 float 比大細；我哋將 CDF 量化成
uint32 桶，實測安全邊際到 1e-12 相對誤差（比引擎實際差異大 4 個數量級）。
改為加黃金向量測試釘死分佈。

## 授權

MIT
