# album-android · 私人相册的安卓外壳 / Android shell for the private album

> 这是**壳**，不是相册本身。界面、布局、上传逻辑全在 web 仓库 `album`：
> 这里只负责浏览器做不到的四件事——全屏无地址栏、返回键、选图、屏幕常亮，
> 外加一个应用内更新。
>
> *This is a shell, not the album. All UI and upload logic live in the `album`
> web repo. This repo only adds what a browser cannot: no URL bar, back
> handling, file picking, keep-awake, plus in-app updates.*

| 项 / Item | 值 / Value |
| --- | --- |
| 包名 / Application ID | `top.chenyouyi.album` |
| minSdk / targetSdk | 26 / 35 |
| 技术栈 / Stack | 单 Activity + WebView，Kotlin 2.0.21，AGP 8.7.3 |
| 体积 / Size | release 约 118 KB（R8 之后） |
| 分发 / Distribution | 私有，不上应用商店；APK 走 `photos.chenyouyi.top/apk/` |

## 1. 它加载什么 / What it loads

打开 App 就是 `https://photos.chenyouyi.top/`。地址在 `gradle.properties` 的
`album.siteUrl` 里，构建期注入 `BuildConfig.SITE_URL`——Kotlin 代码里不写域名，
换域名只改一行配置。

*The app opens the live site. The origin lives in `album.siteUrl` and is injected
as `BuildConfig.SITE_URL` at build time; no domain appears in Kotlin sources.*

## 2. 与 web 仓库的契约 / Contract with the web repo

三个地方跨仓库耦合，改一边必须改另一边：

*Three couplings span the two repos; change one side and you must change the other.*

| 契约 / Contract | 本仓库 / Here | web 仓库 / In `album` |
| --- | --- | --- |
| 原生桥方法名 | `AlbumBridge.kt` 的 `setKeepScreenOn` / `reloadSite` / `appVersion` | `src/web/js/native.js` 里的字面量调用 |
| 返回键两段式 | `MainActivity` 调 `window.__canGoBack()` / `__goBack()` | `native.js` 挂上这两个函数，`main.js` 交给桥 |
| 站点地址 | `gradle.properties` 的 `album.siteUrl` | 构建产物里的绝对路径都相对站点根 |

`scripts/check.mjs` 把本仓库这一侧钉住了（8 项断言）；web 那一侧由 `album`
仓库的 `npm run verify` 守着。两边都改完才叫改完。

*`scripts/check.mjs` pins this side (8 assertions); the web side is guarded by
`npm run verify` in the `album` repo. "Done" means both sides changed.*

## 3. 构建 / Build

需要 JDK 17 与 Android SDK 35。首次构建会下载 Gradle 与依赖。

*JDK 17 and Android SDK 35 are required; the first build downloads Gradle and
dependencies.*

```bash
./gradlew assembleDebug      # 调试包，可直连电脑调试 WebView
./gradlew assembleRelease    # 签名包，产物在 app/build/outputs/apk/release/
node scripts/check.mjs       # 8 项结构自检
```

国内网络下载 Gradle 分发与 Maven 依赖常常超时。两个可选加速（**都不入库**）：

*Gradle distribution and Maven downloads time out often from mainland China. Two
optional accelerators, neither committed:*

1. `~/.gradle/init.d/aliyun-mirrors.gradle` 把 `google()` / `mavenCentral()` 指到阿里云镜像。
2. `gradle/wrapper/gradle-wrapper.properties` 的 `distributionUrl` 换华为云镜像（改完记得别提交，或提交时写清理由）。

## 4. 签名 / Signing

`keystore.properties`（**不入库**）与 `album-release.keystore`（**不入库**）放在仓库根：

*`keystore.properties` and the keystore live at the repo root and are never
committed:*

```properties
storeFile=album-release.keystore
storePassword=********
keyAlias=album
keyPassword=********
```

没有这份文件时 `assembleRelease` 会产出 `app-release-unsigned.apk`（装不上），
**不会**回退到 debug key——debug key 签的包以后无法覆盖安装正式版。

*Without it the release build stays unsigned and will not install. There is no
debug-key fallback: an app signed with the debug key can never be updated in
place.*

> ⚠️ keystore 与口令丢了，就再也发不出能覆盖安装的更新——只能让用户卸载重装。
> 请抄进密码管理器，不要只留在磁盘上。
>
> *Lose the keystore or its passwords and you can never ship an update that
> installs over the existing app — users would have to uninstall first.*

## 5. 发布 / Publish

```bash
DOWNLOADS_BUCKET=chenyouyi-downloads \
SITE_DOMAIN=photos.chenyouyi.top \
DISTRIBUTION_ID=E2UWEFMOKOQEES \
node scripts/publish-apk.mjs --notes "这次的改动"
```

它会做三件事：传 `apk/album-<versionCode>.apk`（内容不变，长缓存）→ 覆盖
`apk/version.json`（no-cache）→ 失效清单那一个路径。客户端只读 `version.json`，
比对 `versionCode` 决定要不要提示更新。

*It uploads the APK under a version-named key with a long cache, overwrites
`apk/version.json` with no-cache, then invalidates just that path. The client
reads only the manifest and compares `versionCode`.*

**不要**把 APK 传到站点桶：`/apk/*` 是 CloudFront 上一条独立行为，回源到
`chenyouyi-downloads`，发错桶就是 404/403。

***Never** upload the APK to the site bucket: `/apk/*` is a separate CloudFront
behaviour backed by `chenyouyi-downloads`.*

## 6. 版本号 / Version

唯一来源是 `app/version.properties`：

*Single source of truth:*

```properties
versionCode=1        # 每次发版 +1，客户端靠它判断新旧
versionName=1.0.0    # 给人看的
```

`build.gradle.kts`、`scripts/publish-apk.mjs`、客户端更新逻辑都读这一处。改别处
会出现「永远提示有新版、装完还是旧版」的死循环。

*Read by Gradle, the publish script and the updater. Duplicating it anywhere else
produces the classic "update available forever, still the old version after
installing" loop.*

## 7. 装不上 / 被拦？先看这里 / Install blocked?

国产 ROM 与三星都会拦侧载，且入口名字不一样：

*Chinese OEMs and Samsung block sideloading in differently-named settings:*

| 机型 / Device | 路径 / Path |
| --- | --- |
| 小米 / Xiaomi | 设置 → 应用设置 → 授权管理 → 安装未知应用 → 允许「相册」 |
| 荣耀 / HONOR | 设置 → 安全 → 更多安全设置 → 外部来源应用下载 → 允许 |
| 三星 / Samsung | 设置 → 应用程序 → 特殊访问权限 → 安装未知应用 → 允许「相册」 |
| 一加 / OPPO / vivo | 设置 → 安全 → 安装未知应用 / 外部来源 |

装完首次打开若提示「网络不可用」，先确认手机浏览器能打开
`https://photos.chenyouyi.top`：能打开就是壳的问题，打不开就是网络或域名解析。
离线页会把 WebView 的真实错误码（如 `net::ERR_NAME_NOT_RESOLVED`）印在页面上，
截图即可定位。

*If the app shows "network unavailable", first check the same URL in the phone
browser. The offline page prints the raw WebView error code so a screenshot
identifies DNS / timeout / TLS issues.*

## 8. 它与 CI 的关系 / Relation to CI

APK **不在 CI 里构建**：签名私钥不进任何流水线，构建与发布都在本机完成，
一条命令一条可回滚的产物。web 与基础设施各有自己的 GitHub Actions 流水线，
三者的分工见 `album` 仓库的 `docs/cicd-architecture.md`。

*The APK is deliberately **not** built in CI: the signing key never enters a
pipeline, and publishing is one local command producing one revertible artifact.
The web and infrastructure repos each have their own Actions pipelines; the full
division of labour is in `docs/cicd-architecture.md` in the `album` repo.*
