# CURSOR.md

## Feature
nvm-windows Node.js 偵測支援

## Goal
讓 Windows 上使用 nvm-windows 的使用者，在 Qclaw 環境檢查與 Gateway 啟動時能正確偵測到其管理的 Node.js，而非回退至內建安裝。

## Scope (MVP)
- `checkNode()` 在 Windows 上能透過 `NVM_HOME` 或 `%APPDATA%\nvm` 偵測 nvm-windows 安裝的 Node
- `resolveNodeInstallStrategy()` 在 Windows 上能正確回傳 `'nvm'`（含路徑大小寫不一致的情況）
- `resolveQualifiedNodeRuntime()` 在 Windows 上能列舉 nvm-windows 版本（已完成）

## Out of Scope (for now)
- 透過 Qclaw UI 自動安裝 Node 至 nvm-windows（nvm install）
- nvm-windows 版本切換 UI
- 支援其他 Windows Node 版本管理器（如 fnm、Volta）

## UX
使用者操作路徑（top-down）：

```
EnvCheck.tsx（掛載後延遲觸發 runChecks）
  → window.api.checkNode()
  → preload: ipcRenderer.invoke('env:checkNode')
  → ipc-handlers.ts: ipcMain.handle('env:checkNode', () => checkNode())
  → cli.ts: checkNode()
       ├─ 第 1332 行：const nvmDir = !isWin ? await detectNvmDir() : null
       │   ⚠ Windows 上 nvmDir 恆為 null → nvmNode 恆為 null
       │   ⚠ detectNvmDir() 是 cli.ts 內的 private 函式，非 nvm-node-runtime.ts 的
       ├─ resolveNodeFromShell()  → where node / which node
       ├─ selectPreferredNodeRuntime({ shellNode, nvmNode: null, nvmDir: null })
       └─ listNodeExecutableCandidates → 逐個嘗試

Gateway 啟動路徑：
  ensureRuntimeReady() → checkNode()  → 同上

子程序路徑（已修改，不經過 checkNode）：
  runNodeEvalWithQualifiedRuntime() → resolveQualifiedNodeRuntime()
       ├─ win32: detectNvmWindowsDir + listInstalledNvmWindowsNodeExePaths ✅
       └─ 非 win32: detectNvmDir (from nvm-node-runtime.ts) ✅
```

成功回饋：環境檢查頁 Node 版本顯示綠勾，installStrategy 為 'nvm'
失敗回饋：偵測不到 Node → 提示安裝

## Technical Notes

### 問題 1：checkNode() 未接入 nvm-windows
- `cli.ts` 第 1332 行 `!isWin` 硬跳過 → 需改為 Windows 上呼叫 nvm-windows 偵測
- cli.ts 內有私有 `detectNvmDir()`（第 1385 行），只處理 POSIX nvm
- 需在 checkNode() 加入：Windows 上呼叫 `detectNvmWindowsDir()`，並用結果掃描版本

### 問題 2：路徑比較大小寫敏感
- `resolveNodeInstallStrategy()` 在 `node-runtime-selection.ts`
- 目前用 `.startsWith()` 比較正規化後的路徑
- Windows 路徑大小寫不敏感：`C:\Users\` == `c:\users\`
- 需加 `.toLowerCase()` 再比較

### 檔案觸碰點
| 檔案 | 改動 |
|------|------|
| `electron/main/cli.ts` | checkNode() 加入 nvm-windows 偵測 |
| `electron/main/node-runtime-selection.ts` | 路徑比較加 toLowerCase() |
| `electron/main/__tests__/nvm-node-runtime.test.ts` | 補大小寫邊界測試 |
| `electron/main/__tests__/node-runtime-selection.test.ts` | 補大小寫邊界測試 |

## Test Checklist

### 正常情況
- [x] nvm-windows 安裝的 Node 能被 resolveQualifiedNodeRuntime 偵測（已有）
- [ ] nvm-windows 安裝的 Node 能被 checkNode() 偵測
- [x] POSIX nvm 偵測不受影響（已有）

### 邊界情況
- [ ] Windows 路徑大小寫不一致時 resolveNodeInstallStrategy 仍回傳 'nvm'
  例：binDir='C:\Users\Jason\AppData\Roaming\NVM\v22\' vs nvmDir='c:\users\jason\appdata\roaming\nvm'
- [ ] NVM_HOME 環境變數不存在但 %APPDATA%\nvm 存在（已有，需驗證 checkNode 路徑）
- [ ] NVM_HOME 和 APPDATA 都不存在 → 回退 installer（已有）

### 錯誤情況
- [x] nvm-windows 目錄無法讀取 → 回傳空陣列（已有）
- [x] POSIX nvm 目錄不存在 → 回傳 null（已有）
