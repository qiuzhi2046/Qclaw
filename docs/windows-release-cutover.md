# Windows 自动更新切换手册

## 目的

- 将当前 Windows 自动更新源从占位地址切换到真实发布地址。
- 复用现有 `generic + latest.yml` 目录结构，不另起一套发布约定。
- 为真实双版本升级验证提供固定操作步骤。

## 当前约定

- 客户端更新源来自：
  - `electron-builder.json` 的 `publish.url`
  - 或 `QCLAW_UPDATE_PUBLISH_URL`
  - 或 `electron-builder.local.json`
- 现有发布辅助脚本：
  - [prepare-cos-update-release.mjs](/D:/Qclaw_Dev/Qclaw/scripts/prepare-cos-update-release.mjs:1)
- 现有本地配置读取逻辑：
  - [electron-builder-local-config.mjs](/D:/Qclaw_Dev/Qclaw/scripts/electron-builder-local-config.mjs:1)

## 推荐切换方式

优先级从高到低：

1. 本地验证：
   - 使用 `electron-builder.local.json`
2. CI / 临时发布：
   - 使用环境变量 `QCLAW_UPDATE_PUBLISH_URL`
3. 正式默认值：
   - 再考虑更新 [electron-builder.json](/D:/Qclaw_Dev/Qclaw/electron-builder.json:1) 里的占位 URL

这样做的好处是：

- 不会把临时地址直接写死进仓库。
- 可以先小范围验证，再决定是否改默认值。

## `electron-builder.local.json` 示例

```json
{
  "publish": {
    "url": "https://your-real-host.example.com/qclaw/latest/current"
  },
  "cos": {
    "baseUrl": "https://your-real-host.example.com/qclaw"
  }
}
```

说明：

- `publish.url` 应直接指向客户端拉取 `latest.yml` 的 `current` 目录。
- `cos.baseUrl` 供 `prepare-cos-update-release.mjs` 生成上传清单时使用。
- `cos.baseUrl` 不要包含 `latest` 这类 channel 段；脚本会再拼上 `<channel>/current` 与 `<channel>/releases/<version>`。

## 目录结构建议

沿用现有 `prepare-cos-update-release.mjs` 的两段式结构：

```text
<baseUrl>/
  latest/
    current/
      latest.yml
      Qclaw-Lite_<displayVersion>.exe
      Qclaw-Lite_<displayVersion>.exe.blockmap
    releases/
      <version>/
        latest.yml
        Qclaw-Lite_<displayVersion>.exe
        Qclaw-Lite_<displayVersion>.exe.blockmap
```

其中：

- `current/` 给客户端实际拉取更新使用
- `releases/<version>/` 做归档

## 切换步骤

1. 准备真实 `HTTP(S)` 发布地址。
2. 配置 `electron-builder.local.json` 或环境变量 `QCLAW_UPDATE_PUBLISH_URL`。
3. 运行 Windows 打包命令：
   - `npm run package:win:unsigned`
4. 运行发布清单脚本：
   - `node scripts/prepare-cos-update-release.mjs --release-dir release/<displayVersion> --channel latest --base-url <baseUrl>`
5. 按脚本生成的 `cos-upload-manifest.json` 上传文件。
6. 先上传安装包与 `.blockmap`。
7. 最后上传 `latest.yml`。
8. 在旧版本客户端里执行真实升级验证。

## 双版本升级验证

1. 安装旧版本。
2. 将新版本产物发布到真实地址。
3. 启动旧版本并打开 Qclaw 更新弹窗。
4. 点击“重新检查”。
5. 确认识别到新版本。
6. 点击“下载更新包”。
7. 点击“安装更新”。
8. 确认：
   - 安装器正常启动
   - 安装完成后 Qclaw 自动重新打开
   - 新启动的版本号正确

## 回退方案

如果真实地址切换后发现客户端无法更新，先按下面顺序排查：

1. `publish.url` 是否指向 `current/`
2. `latest.yml` 是否最后上传
3. `latest.yml` 里的版本号是否大于旧版本
4. `.exe` 与 `.blockmap` 是否与 `latest.yml` 中记录的文件名一致
5. 客户端是否仍读取到了占位地址

如果仍有问题：

- 保留 `releases/<version>/` 归档
- 回滚 `current/` 到上一个可用版本

## 当前阻塞项

真正完成这一阶段，还需要你提供最终的 Windows 发布链接。

收到真实链接后，需要补做两件事：

1. 把占位更新源切换到真实地址
2. 做一次真实双版本升级验证并记录结果
