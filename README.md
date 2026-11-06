# dsh-plugin-updates

*Read-only update intelligence for the agent: per-bundle latest version, engines.dsh gate verdict, and an install-ready spec, resolved from market indexes, npm registry, and git tags.*

升級 DSH 之後，agent 想知道「哪些外掛有新版、裝不裝得上」通常要試探十幾步：查 registry、對 engines 範圍、試裝被擋才知道。裝了這個外掛，那件事變成一次 `plugin_updates scan`——每個 bundle 一行結論，附上可以直接交給 plugin_manager 的安裝規格。

[![test](https://github.com/Joker2377/dsh-plugin-updates/actions/workflows/test.yml/badge.svg)](https://github.com/Joker2377/dsh-plugin-updates/actions/workflows/test.yml)

## 功能

- **plugin_updates（action=scan）** — 對 profile 裡每個 bundle 回報：已裝版本、上游最新版、判定（`outdated`／`behind_gate`＝有新版但最新版會被相容閘門擋、給最高可裝版／`blocked_upstream`／`installed_blocked`／`local_source`／`channel_failed`），以及可直接使用的 spec（如 `dsh-md-studio@1.3.4` 或 `github:owner/repo#v0.5.7`）。
- **plugin_updates（action=package）** — 列單一 npm 套件的所有版本與各自的 `engines.dsh` 範圍，用來挑升級目標。
- **只讀** — 不安裝、不改 profile、不寫任何檔案；安裝照舊走 plugin_manager 的審批流程。

## 安裝

就一個連結。

1. 複製倉庫網址：

   ```text
   https://github.com/Joker2377/dsh-plugin-updates
   ```

2. 在 DSH 側邊欄打開 **Plugins**，把網址貼進安裝欄位，按 **Install**。
3. 重新載入 App。

> [!IMPORTANT]
> 貼倉庫**首頁**網址。`https://github.com/.../tree/main` 這類頁面網址會被拒絕。

## 使用

跟 agent 說「幫我盤一下外掛有沒有新版」或「升級前先看 compatibility」，它會呼叫 `plugin_updates scan`。輸出裡：

- `OUTDATED` 列附 spec，agent 接著用 plugin_manager 安裝即可（會要你確認）。
- `BEHIND_GATE` 列代表最新版在目前的 DSH 版本裝不上，但有一個較舊、仍可裝的版本——spec 給的就是那個。
- `BLOCKED_UPSTREAM`／`INSTALLED_BLOCKED` 列代表要等 upstream 發新版，或需要你明確授權版本豁免。
- `LOCAL_SOURCE` 列（`link:`／`file:`）沒有 upstream，更新取決於你自己的源目錄。

想深挖單一套件：「看看 dsh-ops 有哪些版本裝得上」→ `action=package`。

## 疑難排解

| 症狀 | 可能原因 | 處理 |
| --- | --- | --- |
| 「讀不到 profile」 | profile 不在 `~/.dsh/profiles` 或有多个且無法判定 | 呼叫時傳 `profileDir` 指向含 `package.json` 的 profile 目錄 |
| 大量 `CHANNEL_FAILED` | 網路／registry 連不上，market index 也掛了 | 網路恢復後加 `refresh: true` 重掃 |
| 判定全是 `unknown` | 拿不到 runtime 版本 | 傳 `hostVersion`（執行中 DSH 的版本號） |
| market 資料過舊 | 索引快取 TTL 1 小時 | `refresh: true` 強制重抓 |

## 運作原理

1. 讀 profile 的 `package.json`：`dependencies` 宣告來源與 spec，`node_modules/<name>/package.json` 給實際已裝版本。
2. 按來源分流：npm 源先查兩個社群 market index（單次抓取含版本與 `engines.dsh`，快取 1 小時），缺漏才 per-name 問 npm registry；`github:` 源用 `git ls-remote --tags`；`link:`／`file:` 標記本地；`@deepseek-ai/*` 與 runtime 同版免查。
3. 用內建 semver 實作重現 DSH 的判定：`engines.dsh` 存在時單獨決定，否則由 `@deepseek-ai/dsh*` peers 全過才算過（等同 DSH 安裝時的 `semver.satisfies(…, { includePrerelease: true })`）。
4. 判定失敗的最新版會回頭找「最高可裝版本」，所以 `behind_gate` 的 spec 永遠是真的能裝的那個。

## 開發

```bash
node scripts/check.mjs    # manifest／patch／README 形状檢查
npm test                  # 不需要安裝依賴，也不需要 DSH
```

CI（GitHub Actions）跑的就是這兩條，於 ubuntu＋windows × Node 22／24 矩陣，不 `npm install`。測試以注入的假 market／registry／git 驗證完整判定表；未安裝 DSH 環境時 `defineTool` 退回恆等實現，所有測試照常全綠（無 SKIP）。

## 已知限制

- 不安裝、不快照、不回滾——那些是 plugin_manager（與 agent 的檔案工具）的職責，本外掛刻意不重造。
- `github:` 源的相容性無法事前判定（要拉到 manifest 才知道 engines），故 git 列的 gate 恆為 `na`，由安裝時的 plugin_manager 把關。
- market index 是第三方目錄，覆蓋不完整、資料可能滞后；掃描會以 registry 兜底，但「最新」以 registry 為準、index 只加速。
- 排程、自動升級、變更歷史追蹤都不在本外掛範圍。

## 授權

MIT，見 [LICENSE](LICENSE)。
