/**
 * 离线渲染 UI 预览页（用来"改样式前先看一眼"，不用起浏览器截图）。
 *
 *   node src/server/server.ts        # 先启动服务（预览要用真实数据）
 *   pnpm preview:ui                  # 产出 data/_preview/preview{,-dark}.html
 *
 * 产出两份**自包含**的静态 HTML（海报已内嵌 base64，不需要联网、不需要服务在跑）：
 *   - preview.html       跟随系统主题
 *   - preview-dark.html  强制深色（靠 styles.css 的 .theme-dark 令牌覆盖）
 *
 * 为什么需要它：本机（DSH 沙箱下）跑不起无头 Chrome/Edge —— 它们的 crashpad 与网络沙箱
 * 会被文件沙箱挡掉（`OpenProcess: 拒绝访问`），所以没法 `--screenshot`。这个脚本改走
 * 「离线渲染成静态页 + 用系统浏览器打开」，看到的就是上线的样子。
 *
 * ⚠ 它有三条刻意的做法，改之前先理解：
 *   1. **不复制任何模板**：直接把 `web/app.js` 里真实的渲染函数抽出来执行，
 *      CSS 也是读 `web/styles.css`。所以预览和线上不会走样。
 *   2. 抽取时把 `$('#app').innerHTML = ...` 改写成给一个局部变量赋值 ——
 *      这样不用真 DOM 就能拿到渲染结果（其余 `$(...)` 仍走哑元素）。
 *   3. **只证明静态样式**：它不证明交互。交互要看浏览器里真人点，
 *      或者像本轮那样临时用 DOM 壳跑 app.js 做断言。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const OUT_DIR = process.env.OUT_DIR ?? path.resolve('data/_preview');
const APP_PATH = path.resolve('web/app.js');
const CSS_PATH = path.resolve('web/styles.css');

/**
 * 用 `new Function` 执行从 `web/app.js` 抽出来的渲染函数。
 *
 * 为什么不 `import`：`web/` 是给浏览器用的原生 ES 模块，它直接引用 `document` / `fetch`，
 * 在 Node 里 import 会在模块初始化时就炸（`document is not defined`）。所以只能取出那段
 * 源码、塞进自己准备的壳里执行。**执行的永远是本仓库 `web/app.js` 的内容**，
 * 不含任何外部输入 —— 这是本地开发工具，不接受远程代码。
 */
function makeFunction(args: string[], body: string): (...fnArgs: unknown[]) => Record<string, unknown> {
  const factory = new Function(...args, body) as (...fnArgs: unknown[]) => Record<string, unknown>;
  return factory;
}

// 预览只用到这些字段，按需声明（比 any 安全，也比全量类型省事）
type PreviewSubject = {
  key: string;
  titleCn: string | null;
  coverUrl: string | null;
  firstAirAtUtc: string | null;
  mediaType: string;
  broadcastWeekdayJst: number | null;
  broadcastTimeJst: string | null;
  genres: string[];
  platforms: { name: string }[];
  titleCnSource: string;
  totalEps: number | null;
  status: string;
  episodeCount: number;
  nextAirAtUtc: string | null;
  myCategory: string | null;
  myWatchedEps: number;
  titleOriginal: string | null;
  titleEn: string | null;
  durationMin: number | null;
};
type PreviewOverview = {
  season: { id: string; label: string };
  totals: { all: number };
  subjects: PreviewSubject[];
};
type PreviewWeek = {
  days: { items: PreviewSubject[] }[];
  upcoming: PreviewSubject[];
};

type StubElement = {
  innerHTML: string;
  textContent: string;
  value: string;
  href: string;
  dataset: Record<string, string>;
  style: { cssText: string; marginTop: string };
  classList: { add: () => void; toggle: () => void };
  addEventListener: () => void;
  replaceWith: () => void;
  prepend: () => void;
  remove: () => void;
  firstElementChild: null;
};

// ---------------------------------------------------------------------------
// 1. 抽取 web/app.js 里的真实渲染函数
// ---------------------------------------------------------------------------

const appSource = readFileSync(APP_PATH, 'utf8');

const START_ANCHOR = 'const WEEKDAYS';
const END_ANCHOR = '// 视图：我的追番 / 补番库';
const startAt = appSource.indexOf(START_ANCHOR);
const endAt = appSource.indexOf(END_ANCHOR);
if (startAt < 0 || endAt < 0) {
  throw new Error(
    `抽不出渲染函数：在 web/app.js 里找不到锚点（${START_ANCHOR} / ${END_ANCHOR}）。` +
      '应该是这两个位置附近的结构被改动了，同步更新本脚本的锚点。',
  );
}

// `$('#app').innerHTML = ...` → 赋值给局部变量，这样不用真 DOM 也能拿到 HTML。
// `$('#subject-list')` / `$('#active-filters')` 是面板外的局部重绘，静态预览不需要。
const renderSlice = appSource
  .slice(startAt, endAt)
  .replaceAll("$('#app').innerHTML =", '__APP_HTML__ =')
  .replaceAll("$('#subject-list')", 'undefined')
  .replaceAll("$('#active-filters')", 'undefined');

type RenderApi = {
  renderWeek: () => Promise<void>;
  renderSeason: () => void;
  state: Record<string, unknown>;
  getHtml: () => string;
};

function makeRenderers(overview: PreviewOverview, week: PreviewWeek): RenderApi {
  const captured = new Map<string, string>();
  const stub = (selector: string): StubElement => ({
    get innerHTML() {
      return captured.get(selector) ?? '';
    },
    set innerHTML(value: string) {
      captured.set(selector, value);
    },
    textContent: '',
    value: '',
    href: '',
    dataset: {},
    style: { cssText: '', marginTop: '' },
    classList: { add: () => {}, toggle: () => {} },
    addEventListener: () => {},
    replaceWith: () => {},
    prepend: () => {},
    remove: () => {},
    firstElementChild: null,
  });

  const body = `
    let __APP_HTML__ = '';
    // 注入的 $ ：预览不需要真 DOM，只要 innerHTML 可写
    const $ = (selector, root) => (root ? root.querySelector?.(selector) ?? null : stubFor(selector));
    // 预览是静态的：面板重绘与事件绑定不需要真的发生
    const renderFilterPanelOnly = () => {};
    ${renderSlice}
    return { renderWeek, renderSeason, state, getHtml: () => __APP_HTML__ };
  `;
  const factory = makeFunction(['document', 'fetch', 'stubFor'], body);
  const api = factory(
    { createElement: () => stub('tmp-created'), addEventListener: () => {} },
    // renderWeek 会自己调 fetch；相对 URL 在 Node 里不合法，这里直接喂已拉好的数据
    async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(String(url).includes('/api/week') ? week : overview),
    }),
    stub,
  );
  Object.assign(api.state as Record<string, unknown>, { overview });
  return api as unknown as RenderApi;
}

// ---------------------------------------------------------------------------
// 2. 真实数据 + 海报内联
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}（服务起了吗？）`);
  return (await res.json()) as T;
}

const overview = await fetchJson<PreviewOverview>(`${BASE}/api/overview?season=2026-10&sort=firstAir`);
const week = await fetchJson<PreviewWeek>(`${BASE}/api/week?season=2026-10&rule=clock&offset=0`);

const coverCache = new Map<string, string | null>();

async function dataUri(url: string): Promise<string | null> {
  if (coverCache.has(url)) return coverCache.get(url) ?? null;
  let uri: string | null = null;
  try {
    const res = await fetch(url, { headers: { referer: 'https://anilist.co/' } });
    if (res.ok) {
      const type = res.headers.get('content-type') ?? 'image/jpeg';
      uri = `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
    }
  } catch {
    uri = null;
  }
  coverCache.set(url, uri);
  return uri;
}

const coverUrls = new Set<string>();
// 列表按「首集放送时间」排，而演示里筛的是「周五 + TV」——多拿一些才覆盖得到
for (const subject of overview.subjects.slice(0, 60)) if (subject.coverUrl) coverUrls.add(subject.coverUrl);
for (const day of week.days) for (const item of day.items) if (item.coverUrl) coverUrls.add(item.coverUrl);
for (const item of week.upcoming) if (item.coverUrl) coverUrls.add(item.coverUrl);
for (const url of coverUrls) await dataUri(url);

const inlined = [...coverCache.values()].filter(Boolean).length;
console.log(`海报：${inlined} / ${coverCache.size} 张已内联（拿不到的会退化成占位块，不留破图）`);

/** 远程图片换成 data URI；拿不到的退化成占位块。 */
function inlineCovers(html: string): string {
  return html.replace(/<img class="([^"]*)" src="([^"]*)"[^>]*>/g, (_match, cls: string, src: string) => {
    const uri = coverCache.get(src.replace(/&amp;/g, '&'));
    return uri ? `<img class="${cls}" src="${uri}" alt="" />` : `<div class="${cls} ep-cover-ph">◈</div>`;
  });
}

// ---------------------------------------------------------------------------
// 3. 渲染各视图
// ---------------------------------------------------------------------------

async function renderWeekHtml(): Promise<string> {
  const api = makeRenderers(overview, week);
  await api.renderWeek();
  return inlineCovers(api.getHtml());
}

/** 筛选条件：四个维度都是 `{ include, exclude }`（三态），`side` 是第 2 层的状态预设。 */
type PreviewFilters = Record<string, unknown>;

function renderSeasonHtml(filters: PreviewFilters): string {
  const api = makeRenderers(overview, week);
  Object.assign(api.state, { filters });
  api.renderSeason();
  return inlineCovers(api.getHtml());
}

const weekHtml = await renderWeekHtml();
// 演示状态刻意凑齐四种视觉，一张图里就能看出三态的差别：
//   含（✓ + 实心）→ 周五、TV、奇幻；不含（⊘ + 删除线 + 危险色）→ 成人；不选 → 其余全部。
// 同一栏里"含 + 不含"都有（类型标签），这样折叠标题上的「已选 1 · 排除 1」也看得见。
const seasonHtml = renderSeasonHtml({
  weekdays: { include: ['5'], exclude: [] },
  mediaTypes: { include: ['TV'], exclude: [] },
  genres: { include: ['Fantasy'], exclude: ['Hentai'] },
  platforms: { include: [], exclude: [] },
  side: [],
});

// ---------------------------------------------------------------------------
// 4. 拼静态页（顶栏与标签页是手写的静态替身：真实版本由 app.js 在运行时填充）
// ---------------------------------------------------------------------------

const staticTopbar = (menuOpen: boolean): string => `
  <header class="top">
    <div class="brand">
      <span class="logo">◈</span>
      <h1>新番追番日历</h1>
      <span class="season-badge">2026 年 10 月</span>
    </div>
    <div class="controls">
      <label class="field"><span>季度</span>
        <select><option>2026-10 · 112 部</option><option>2026-07 · 151 部</option></select>
      </label>
      <label class="field"><span>日历归属</span>
        <select><option>按真实钟点</option><option>按日本放送日历</option></select>
      </label>
      <button class="btn btn-primary">更新数据</button>
      <details class="menu"${menuOpen ? ' open' : ''}>
        <summary class="btn">更多 <span class="caret">▾</span></summary>
        <div class="menu-panel">
          <button class="btn">只同步本季</button>
          <button class="btn">补全中文名（机翻）</button>
          <a class="btn" href="#">导出日历 (.ics)</a>
          <a class="btn" href="#">导出我的数据</a>
        </div>
      </details>
    </div>
  </header>
  <nav class="tabs">
    <button class="tab is-active">周视图</button>
    <button class="tab">全季总览</button>
    <button class="tab">我的追番 <span class="pill">23</span></button>
    <button class="tab">变更 <span class="pill">0</span></button>
    <button class="tab">搜索 / 加番</button>
    <span class="spacer"></span>
  </nav>`;

const css = readFileSync(CSS_PATH, 'utf8');

function buildPage(forceDark: boolean): string {
  const section = (label: string, body: string): string =>
    `<section class="shot-label">${label}</section><div>${body}</div>`;

  return `<!doctype html>
<html lang="zh-CN"${forceDark ? ' class="theme-dark"' : ''}>
<head>
<meta charset="utf-8" />
<title>新番追番日历 · UI 预览（${forceDark ? '深色' : '跟随系统'}）</title>
<style>
${css}
/* ↓ 仅预览页使用的样式 */
main { max-width: none; }
.shot-label {
  margin: 26px 22px 12px;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 1px;
  color: var(--accent);
  border-left: 3px solid var(--accent);
  padding-left: 9px;
}
.preview-note {
  margin: 0;
  padding: 11px 22px;
  font-size: 12.5px;
  color: var(--text-dim);
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}
</style>
</head>
<body>
<p class="preview-note">
  离线预览（样式与渲染函数都取自 <code>web/</code> 真实代码，海报已内嵌，不需要联网）。
  当前：<b>${forceDark ? '强制深色' : '跟随系统主题'}</b>。线上是跟随系统的，
  同一个页面在浅色 / 深色系统下会自动切换。
</p>
${staticTopbar(true)}
<main>
  ${section('① 周视图（顶栏「更多」菜单展开 + 海报已放大）', weekHtml)}
  ${section('② 全季总览（筛选面板展开，已选「周五 + TV」）', seasonHtml)}
</main>
</body>
</html>`;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [suffix, forceDark] of [
  ['preview.html', false],
  ['preview-dark.html', true],
] as const) {
  const html = buildPage(forceDark);
  writeFileSync(path.join(OUT_DIR, suffix), html, 'utf8');
  console.log(`已写出 ${path.join(OUT_DIR, suffix)}（${Math.round(html.length / 1024)} KB）`);
}
console.log('用浏览器打开即可（文件已自包含）。');
