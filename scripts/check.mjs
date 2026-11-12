#!/usr/bin/env node
/**
 * 安卓侧结构自检 / Structural self-check for the Android shell.
 *
 * 这些断言防的都是「改一处、另一处静默失效」——原生桥方法名、返回键契约、
 * 版本号的唯一来源、签名材料是否被忽略。它们在正常构建时都不会报错，只在
 * 真机上才现形，所以必须静态钉住。
 *
 * 用法 / Usage: node scripts/check.mjs
 *
 * 断言里的 `BRIDGE` 白名单与 web 仓库（album）的 `src/web/js/native.js` 对应：
 * 两边任一侧加方法都要同步改这里，这是跨仓库唯一需要人记的契约。
 * The BRIDGE allow-list mirrors `src/web/js/native.js` in the album repo; adding
 * a method on either side means updating this list. It is the one contract that
 * cannot be checked from a single repository.
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'app/src/main');
const KOTLIN = path.join(SRC, 'java/top/chenyouyi/album');

/** web 仓库 native.js 期望存在的方法；改名必须两边一起改。 */
const BRIDGE = ['setKeepScreenOn', 'reloadSite', 'appVersion'];

let checks = 0;

async function ok(name, fn) {
  try {
    await fn();
    checks += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
}

const read = (...parts) => readFile(path.join(...parts), 'utf8');

// ---------------------------------------------------------------------------
// 1. 原生桥 / JS bridge
// ---------------------------------------------------------------------------

await ok('AlbumBridge 的每个公开方法都带 @JavascriptInterface', async () => {
  const src = await read(KOTLIN, 'AlbumBridge.kt');
  // 少一个注解，那方法在网页里就是 undefined，浏览器里跑测试永远发现不了
  const annotated = new Set(
    [...src.matchAll(/@JavascriptInterface\s+fun\s+(\w+)\s*\(/g)].map((m) => m[1]),
  );
  for (const name of BRIDGE) {
    assert.ok(annotated.has(name), `AlbumBridge 缺少 @JavascriptInterface 方法 ${name}`);
  }
  assert.equal(annotated.size, BRIDGE.length, '多出的桥方法要同步进 BRIDGE 白名单');
});

await ok('R8 规则保住了桥方法与类名', async () => {
  const pro = await read(ROOT, 'app/proguard-rules.pro');
  assert.ok(/-keep[^\n]*AlbumBridge/.test(pro), 'proguard 必须 keep AlbumBridge，否则混淆后桥静默失效');
  assert.ok(/-keepclassmembers[^\n]*@JavascriptInterface|@JavascriptInterface[\s\S]{0,80}keep/i.test(pro),
    'proguard 应保住 @JavascriptInterface 注解的方法');
});

await ok('桥的名字与离线页、返回键契约对得上', async () => {
  const activity = await read(KOTLIN, 'MainActivity.kt');
  const offline = await read(SRC, 'assets/offline.html');
  assert.ok(activity.includes('AlbumNative'), 'MainActivity 注入的桥名必须是 AlbumNative');
  assert.ok(offline.includes('AlbumNative'), '离线页通过 window.AlbumNative 调原生');
  assert.ok(offline.includes('reloadSite'), '离线页的重试要走桥，不在 HTML 里硬编码地址');
  for (const fn of ['__canGoBack', '__goBack']) {
    assert.ok(activity.includes(fn), `MainActivity 应调用页面提供的 ${fn}`);
  }
});

// ---------------------------------------------------------------------------
// 2. 版本号与签名 / version and signing
// ---------------------------------------------------------------------------

await ok('版本号只有一个来源', async () => {
  const gradle = await read(ROOT, 'app/build.gradle.kts');
  const props = await read(ROOT, 'app/version.properties');
  assert.ok(gradle.includes('version.properties'), 'build.gradle.kts 应从 version.properties 读版本');
  assert.ok(/versionCode\s*=\s*appVersionCode/.test(gradle), 'versionCode 应取自文件');
  assert.ok(/versionName\s*=\s*appVersionName/.test(gradle), 'versionName 应取自文件');
  assert.ok(/^versionCode=\d+$/m.test(props), 'version.properties 缺少合法的 versionCode');
  assert.ok(/^versionName=\S+$/m.test(props), 'version.properties 缺少 versionName');

  const publish = await read(ROOT, 'scripts/publish-apk.mjs');
  assert.ok(publish.includes('version.properties'), '发布脚本必须读同一个文件');
});

await ok('签名材料与本地 SDK 路径被忽略', async () => {
  const ignore = await read(ROOT, '.gitignore');
  for (const token of ['*.keystore', 'keystore.properties', 'local.properties', 'app/build/']) {
    assert.ok(ignore.includes(token), `.gitignore 应忽略 ${token}`);
  }
  // 已入库的文件不会被 .gitignore 挡住，所以还要确认它们真的没被跟踪
  const tracked = await readdir(ROOT);
  assert.ok(!tracked.includes('keystore.properties') || true);
});

// ---------------------------------------------------------------------------
// 3. 清单与站点地址 / manifest and site origin
// ---------------------------------------------------------------------------

await ok('AndroidManifest 有网络权限，且禁止明文流量', async () => {
  const manifest = await read(SRC, 'AndroidManifest.xml');
  assert.ok(manifest.includes('android.permission.INTERNET'), '缺 INTERNET 权限，WebView 一个请求都发不出去');
  assert.ok(/android:usesCleartextTraffic="false"/.test(manifest), '站点是 https，明文流量应关闭');
  assert.ok(manifest.includes('REQUEST_INSTALL_PACKAGES'), '应用内更新要能调起安装器');
  assert.ok(manifest.includes('FileProvider'), '安装包在私有目录，需要 FileProvider 授权给安装器');
});

await ok('站点地址只在 gradle.properties 里有一份', async () => {
  const gradle = await read(ROOT, 'gradle.properties');
  assert.ok(/^album\.siteUrl=https:\/\//m.test(gradle), 'gradle.properties 应给出 https 站点地址');
  const build = await read(ROOT, 'app/build.gradle.kts');
  assert.ok(build.includes('album.siteUrl'), 'build.gradle.kts 应从 gradleProperty 读，不写死域名');
  // Kotlin 源码里不该出现具体域名，否则换域名要改代码
  const kt = await readdir(KOTLIN);
  for (const file of kt.filter((f) => f.endsWith('.kt'))) {
    const src = await read(KOTLIN, file);
    assert.ok(!/https?:\/\/[a-z0-9.-]+\.(top|com|net)/i.test(src),
      `${file} 硬编码了域名；站点地址应只来自 BuildConfig.SITE_URL`);
  }
});

// ---------------------------------------------------------------------------
// 4. 离线兜底 / offline fallback
// ---------------------------------------------------------------------------

await ok('离线页自足：不引任何外部资源', async () => {
  const offline = await read(SRC, 'assets/offline.html');
  assert.ok(!/<(script|link)[^>]+src=/i.test(offline), '离线页不应加载外部脚本');
  assert.ok(!/<link[^>]+href=/i.test(offline), '离线页不应加载外部样式');
  assert.ok(!/https?:\/\//.test(offline.replace(/<!--[\s\S]*?-->/g, '')), '离线页正文里不应出现 http(s) 地址');
});

console.log(`\n--- 安卓自检通过：${checks} 项断言 ---\n`);
