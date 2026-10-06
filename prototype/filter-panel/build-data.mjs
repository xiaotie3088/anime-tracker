/**
 * 一次性工具：把真实的总览数据抓成原型用的静态快照（`data.js`）。
 *
 * 为什么不让原型自己去 fetch：原型是**双击打开的单文件页**（`file://`），
 * 从 `file://` 打 `http://127.0.0.1:8787/api/overview` 会被 CORS 挡掉。
 * 快照烧进文件里，原型就不依赖服务在不在跑 —— 而且每次看到的是同一份数据，
 * 手感对比才有意义。
 *
 * 用法（先在仓库根起服务）：
 *   pnpm web                                        # 另开一个终端
 *   node prototype/filter-panel/build-data.mjs      # 默认 2026-10
 *   node prototype/filter-panel/build-data.mjs 2026-07
 *
 * ⚠ 这是原型工具，不属于产品代码：tsconfig 的 include 里没有 prototype/，不参与类型检查。
 * ⚠ 不改 data/anime.db：只读 HTTP 接口。
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';

const season = process.argv[2] ?? '2026-10';
const base = process.env.BASE ?? 'http://127.0.0.1:8787';
const url = `${base}/api/overview?season=${encodeURIComponent(season)}`;

const response = await fetch(url);
if (!response.ok) throw new Error(`${url} → HTTP ${response.status}（服务起了吗？先跑 pnpm web）`);
const overview = await response.json();

/** 只留原型用得到的字段（平台降成名字数组），文件能小一大半。 */
const subjects = overview.subjects.map((item) => ({
  key: item.key,
  titleCn: item.titleCn,
  titleOriginal: item.titleOriginal,
  titleCnSource: item.titleCnSource,
  mediaType: item.mediaType,
  weekday: item.broadcastWeekdayJst,
  time: item.broadcastTimeJst,
  genres: [...new Set(item.genres)],
  platforms: [...new Set(item.platforms.map((p) => p.name))],
  status: item.status,
  totalEps: item.totalEps,
  firstAirAtUtc: item.firstAirAtUtc,
  myCategory: item.myCategory,
  coverUrl: item.coverUrl,
}));

const payload = {
  season: overview.season,
  totals: overview.totals,
  savedAt: new Date().toISOString(),
  subjects,
};

// `<` 转义成 \u003c：内容是给 <script> 读的，留一个裸 `<` 以后内联就会踩 `</script>`。
const json = JSON.stringify(payload).replaceAll('<', '\\u003c');
const outPath = path.join(import.meta.dirname, 'data.js');
writeFileSync(
  outPath,
  `// 由 build-data.mjs 从 /api/overview 抓下来的真实数据快照（${season}，${subjects.length} 部）。不要手改。\n` +
    `window.PROTO_DATA = ${json};\n`,
  'utf8',
);

const genres = new Set(subjects.flatMap((item) => item.genres));
const platforms = new Set(subjects.flatMap((item) => item.platforms));
console.log(`已写出 ${outPath}`);
console.log(`  季度 ${season}｜番剧 ${subjects.length} 部｜类型标签 ${genres.size} 个｜平台 ${platforms.size} 个`);
console.log(`  其中已在我的列表里：${subjects.filter((item) => item.myCategory).length} 部`);
