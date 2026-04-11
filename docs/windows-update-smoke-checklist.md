# Windows 打包与自动更新 Smoke Checklist

## 使用场景

- 用于验证 Qclaw 在 Windows `x64` 上的 unsigned `NSIS` 打包与自动更新链路。
- 适用于阶段 5 之后的本地 smoke，也适用于后续接入真实发布链接前的手工回归。

## 前置条件

- 一台 Windows `x64` 真机。
- 已安装可用的 `node` 和 `npm`。
- 仓库代码为待验证版本。
- 可以启动一个本地或远端的 `HTTP(S)` 静态文件服务。
- 不使用 `file://` 作为更新源。

## 需要准备的两个版本

1. 旧版本：
   - 能正常安装并启动的 Qclaw Windows 包。
   - 版本号必须低于待验证的新版本。
2. 新版本：
   - 用当前代码打出的 unsigned Windows `NSIS` 包。
   - 对应目录中必须包含：
     - `Qclaw-Lite_<displayVersion>.exe`
     - `latest.yml`
     - 对应 `.blockmap`

## 打包前检查

1. 在 Windows 机器上运行 `npm install`。
2. 运行 `npm run check:win:package-env -- --allow-placeholder-publish --unsigned`。
3. 运行 `npm run package:win:unsigned`。
4. 检查 `release/<displayVersion>/` 中是否存在：
   - `.exe`
   - `latest.yml`
   - `.blockmap`
5. 打开 `latest.yml`，核对：
   - `version` 与本次打包内部 semver 一致。
   - 对比旧版本，确认版本号确实递增。

## 发布目录准备

1. 准备一个 `HTTP(S)` 静态目录作为 `generic` 更新源。
2. 将新版本产物上传到更新目录。
3. 如果当前仍是占位链接：
   - 用本地配置或环境变量把更新源指向该静态目录。
4. 确认客户端最终读取到的更新源不是 `example.invalid`。

## 只更新 Qclaw 链路

1. 安装旧版本 Qclaw。
2. 启动 Qclaw，确认能正常进入主界面。
3. 打开“只更新 Qclaw”弹窗。
4. 点击“重新检查”。
5. 预期结果：
   - 能识别出新版本。
   - 状态不是 `disabled`。
6. 点击“下载更新包”。
7. 预期结果：
   - 可以进入下载中状态。
   - 下载完成后进入“已下载”状态。
8. 点击“安装更新”。
9. 预期结果：
   - Qclaw 退出。
   - NSIS 安装器启动。
   - 安装完成后 Qclaw 自动重新打开。
10. 重新打开后核对版本号已经变成新版本。

## 失败回退链路

1. 人为制造一次自动下载失败或自动安装失败。
2. 再次触发更新。
3. 预期结果：
   - 会自动尝试打开手动下载链接。
   - Windows 文案显示为 `exe / msi 安装包`，不是 `dmg`。

## Combined Update 回归

1. 打开 Combined Update 弹窗。
2. 触发一次组合更新检查。
3. 预期结果：
   - 不因为前面 Qclaw 更新改动而报错。
   - 仍能正常显示 Qclaw 侧更新状态。

## 记录项

- 本次验证机器信息：
  - Windows 版本
  - CPU 架构
  - Node 版本
  - npm 版本
- 旧版本号
- 新版本号
- 更新源 URL
- 是否看到 UAC / “未知发布者”提示
- 是否成功自动重新打开应用
- 是否触发了手动下载回退
- 若失败，记录失败发生在：
  - 检查更新
  - 下载更新
  - 安装交接
  - 安装完成后重开
