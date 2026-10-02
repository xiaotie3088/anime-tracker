/**
 * Phase 0 · 数据源探测脚本（零依赖，不需要先 pnpm install）
 *
 *   node scripts/probe-sources.ts
 *   node scripts/probe-sources.ts --season=2026-10 --only=anilist,yuc
 *   node scripts/probe-sources.ts --dir=D:\anime-probe
 *
 * 目的：在写任何抓取解析代码之前，先用**真实响应**确认三件事：
 *   1. 接口还能用、限速与鉴权要求是什么
 *   2. 关键字段是否真的存在（尤其是 AniList 的每集放送时间 —— 整个日历的精确性靠它）
 *   3. yuc.wiki 的实际 URL 规则与表格结构（这个站的路径我不能凭空假设）
 *
 * 产物：
 *   data/probe-<时间戳>/<源>/<用例>.json|html   原始响应快照（离线可重放）
 *   data/probe-<时间戳>/report.md               人可读的探测结论
 *
 * 这个脚本刻意不依赖 zod / cheerio，保证「clone 下来第一条命令就能跑」。
 * 但它不是正式抓取器：正式实现见 src/providers/，那边才有类型校验与限速策略。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  formatInZone,
  parseIsoRepeatingInterval,
  seasonDateRange,
  seasonFromId,
  seasonOf,
  type SeasonInfo,
} from '../src/core/time.ts';
import { REPO_ROOT } from '../src/providers/snapshot.ts';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

type Args = {
  season: SeasonInfo;
  only: Set<string> | null;
  timeoutMs: number;
  save: boolean;
  dir: string;
  /** 代理地址；用于访问在你所在网络被阻断的域名（例如 api.bgm.tv） */
  proxy: string | null;
};

function parseArgs(argv: string[]): Args {
  const get = (key: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${key}=`));
    return hit?.slice(key.length + 3);
  };
  const seasonArg = get('season');
  const onlyArg = get('only');
  const outDir = get('dir');

  return {
    season: seasonArg ? seasonFromId(seasonArg) : seasonOf(new Date()),
    only: onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null,
    timeoutMs: Number(get('timeout') ?? 20_000),
    save: !argv.includes('--no-save'),
    dir: outDir ?? path.join(REPO_ROOT, 'data', `probe-${new Date().toISOString().replace(/[:.]/g, '-')}`),
    proxy:
      get('proxy') ??
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.ALL_PROXY ??
      process.env.all_proxy ??
      null,
  };
}

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const USER_AGENT = 'anime-tracker/0.1 (Phase 0 data source probe; personal use, low rate)';

type Level = 'ok' | 'warn' | 'fail' | 'info';
type Finding = { level: Level; text: string };

const ICON: Record<Level, string> = { ok: '✓', warn: '!', fail: '✗', info: '·' };
const COLOR: Record<Level, string> = { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', info: '\x1b[90m' };

function line(level: Level, text: string): Finding {
  return { level, text };
}

/** 按路径取值，任何一层缺失都返回 undefined，不会抛错。 */
function deepGet(value: unknown, pathExpr: string): unknown {
  let current: unknown = value;
  for (const key of pathExpr.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// HTML 结构摘要（yuc.wiki 侦察用）
// ---------------------------------------------------------------------------

type HtmlSummary = {
  bytes: number;
  tables: number;
  rows: number;
  scripts: number;
  hasEmbeddedData: boolean;
  likelyJsRendered: boolean;
  keywords: Record<string, boolean>;
  /** 页面上出现的星期表头，用来判断是不是按天排列的放送表 */
  weekdayHeaders: string[];
  sampleRows: string[][];
  headings: string[];
};

const KEYWORDS = ['新番', '更新时间', '首播', '版权', '集数', '制作', '放送', '动画', '哔哩哔哩', 'bilibili', '星期'];

function extractRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const match of html.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const cells = [...match[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
      truncate(stripTags(cell[1]), 36),
    );
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function summarizeHtml(html: string): HtmlSummary {
  const allRows = extractRows(html);

  const weekdayHeaders = [
    ...new Set(
      allRows
        .map((cells) => cells.join(' ').trim())
        .filter((text) => text.length < 40 && /周[一二三四五六日天]/.test(text)),
    ),
  ].slice(0, 10);

  // 页面顶部常是广告区块，取中段的多列表格行更有代表性
  const candidateRows = allRows.filter((cells) => cells.length >= 3);
  const sampleRows = candidateRows.length > 8 ? candidateRows.slice(4, 9) : candidateRows.slice(0, 5);

  const text = stripTags(html);
  const keywords: Record<string, boolean> = {};
  for (const keyword of KEYWORDS) keywords[keyword] = html.includes(keyword);

  const headings = (html.match(/<h[1-3][^>]*>[\s\S]*?<\/h[1-3]>/gi) ?? [])
    .slice(0, 6)
    .map((h) => truncate(stripTags(h), 60))
    .filter(Boolean);

  const scriptCount = (html.match(/<script/gi) ?? []).length;

  return {
    bytes: Buffer.byteLength(html, 'utf8'),
    tables: (html.match(/<table/gi) ?? []).length,
    rows: allRows.length,
    scripts: scriptCount,
    hasEmbeddedData: ['__NEXT_DATA__', '__NUXT__', 'window.__INITIAL_STATE__'].some((k) => html.includes(k)),
    // 大量脚本但极少可见文本 => 前端渲染，纯 HTTP 抓不到内容
    likelyJsRendered: text.length < 1500 && scriptCount > 2,
    keywords,
    weekdayHeaders,
    sampleRows,
    headings,
  };
}

function describeHtmlFinding(label: string, summary: HtmlSummary): Finding[] {
  const findings: Finding[] = [];
  findings.push(
    line(
      summary.rows > 20 ? 'ok' : 'warn',
      `${label}：${summary.bytes} 字节，${summary.tables} 个 table，${summary.rows} 个数据行`,
    ),
  );
  if (summary.hasEmbeddedData) {
    findings.push(line('warn', `${label}：页面存在内嵌 JSON 状态，优先从内嵌 JSON 取数而不是解析 HTML`));
  }
  if (summary.likelyJsRendered) {
    findings.push(line('warn', `${label}：正文文本极少但脚本很多，疑似前端渲染 —— 纯 HTTP 抓不到内容`));
  }
  const present = Object.entries(summary.keywords)
    .filter(([, value]) => value)
    .map(([key]) => key);
  findings.push(line('info', `${label}：命中关键词 [${present.join(', ') || '无'}]`));
  if (summary.weekdayHeaders.length > 0) {
    findings.push(line('ok', `${label}：星期表头 [${summary.weekdayHeaders.join(' / ')}]  ← 按天排列的放送表`));
  }
  if (summary.headings.length > 0) {
    findings.push(line('info', `${label}：标题 ${summary.headings.map((h) => `「${h}」`).join(' ')}`));
  }
  for (const [index, cells] of summary.sampleRows.entries()) {
    findings.push(line('info', `${label}：样例行 ${index + 1} → ${cells.join(' | ')}`));
  }
  return findings;
}

/**
 * 解析 bangumi-data 的 broadcast 字段。
 *
 * 实测格式是 ISO 8601 重复区间：`R/2026-10-07T15:00:00.000Z/P7D`
 * 含义：从 2026-10-07T15:00:00Z 起，每 7 天重复一次。
 * 这直接给出了「日本放送时刻」的 UTC 时间戳，不需要任何猜测。
 *
 * 实现放在 core/time.ts，保证探测脚本与正式抓取器用的是同一份逻辑。
 */
const parseBroadcastInterval = parseIsoRepeatingInterval;

// ---------------------------------------------------------------------------
// 探测用例定义
// ---------------------------------------------------------------------------

type ProbeCase = {
  name: string;
  url: string;
  init?: RequestInit;
  ext?: 'json' | 'html' | 'txt';
  /** 给人看的说明：这个用例到底在确认什么 */
  intent: string;
  /** 已知会失败的用例（例如用来证明某站证书确实过期），不计入「待解决」 */
  expectFailure?: boolean;
  inspect?: (body: string, contentType: string) => Finding[];
};

type ProbeSource = {
  id: string;
  label: string;
  /** 该源在本项目里担任什么角色 */
  role: string;
  cases: ProbeCase[];
};

function anilistCases(season: SeasonInfo): ProbeCase[] {
  const query = `
query ($season: MediaSeason, $seasonYear: Int) {
  Page(page: 1, perPage: 50) {
    pageInfo { total }
    media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: [POPULARITY_DESC]) {
      id idMal
      title { romaji native english }
      format episodes duration status
      startDate { year month day }
      nextAiringEpisode { airingAt episode }
      airingSchedule(perPage: 50) { nodes { airingAt episode } }
      externalLinks { site url }
    }
  }
}`;

  return [
    {
      name: 'season',
      url: 'https://graphql.anilist.co',
      ext: 'json',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query,
          variables: { season: season.aniList, seasonYear: season.year },
        }),
      },
      intent: '确认季度清单能拿到，且每部番的 airingSchedule（每集放送时间戳）是否真的有数据',
      inspect: (body) => {
        const json = JSON.parse(body) as unknown;
        const errors = asArray(deepGet(json, 'errors'));
        if (errors.length > 0) {
          return [line('fail', `GraphQL 报错：${JSON.stringify(errors).slice(0, 300)}`)];
        }
        const media = asArray(deepGet(json, 'data.Page.media'));
        if (media.length === 0) return [line('fail', '季度查询返回 0 部番，检查 season/seasonYear 是否拼错')];

        const withSchedule = media.filter((m) => asArray(deepGet(m, 'airingSchedule.nodes')).length > 0).length;
        const withNext = media.filter((m) => deepGet(m, 'nextAiringEpisode.airingAt') !== undefined).length;
        const withMal = media.filter((m) => deepGet(m, 'idMal') !== undefined).length;
        const withNative = media.filter((m) => deepGet(m, 'title.native') !== undefined).length;
        const withBili = media.filter((m) =>
          asArray(deepGet(m, 'externalLinks')).some((l) => /bilibili/i.test(String(deepGet(l, 'site') ?? ''))),
        ).length;
        const withCn = media.filter((m) => deepGet(m, 'title.chinese') !== undefined).length;

        const ratio = (n: number) => `${n}/${media.length} (${Math.round((n / media.length) * 100)}%)`;

        return [
          line('ok', `共 ${media.length} 部番（pageInfo.total = ${String(deepGet(json, 'data.Page.pageInfo.total'))}）`),
          line(
            withSchedule / media.length > 0.5 ? 'ok' : 'warn',
            `有 airingSchedule 的：${ratio(withSchedule)}  ← 这是日历精确度的生命线，比例太低就得靠 Jikan 兜底`,
          ),
          line('info', `有 nextAiringEpisode 的：${ratio(withNext)}`),
          line(withMal === media.length ? 'ok' : 'warn', `带 idMal 的：${ratio(withMal)}  ← 用于与 MAL/Jikan 对齐`),
          line('info', `带 title.native 的：${ratio(withNative)}`),
          line('info', `带中文标题 title.chinese 的：${ratio(withCn)}（预期为 0，中文名要靠 Bangumi）`),
          line('info', `externalLinks 里有 B站 的：${ratio(withBili)}`),
          line('info', `样例：${String(deepGet(media[0], 'title.romaji'))} / eps=${String(deepGet(media[0], 'episodes'))} / status=${String(deepGet(media[0], 'status'))}`),
        ];
      },
    },
  ];
}

function bangumiCases(season: SeasonInfo): ProbeCase[] {
  const { startDate, endDate } = { startDate: `${season.year}-${String(season.month).padStart(2, '0')}-01`, endDate: '' };
  return [
    {
      name: 'calendar',
      url: 'https://api.bgm.tv/calendar',
      ext: 'json',
      intent: '每日放送接口：确认「放送星期」字段（深夜番归属的原始依据之一）与是否需要 User-Agent',
      inspect: (body) => {
        const json = JSON.parse(body) as unknown;
        const days = asArray(json);
        if (days.length === 0) return [line('fail', '返回不是预期的 7 天数组，接口可能已变更')];
        const first = asArray(deepGet(days[0], 'items'))[0];
        const sample = first
          ? `id=${String(deepGet(first, 'id'))} name_cn=${String(deepGet(first, 'name_cn'))} air_weekday=${String(deepGet(first, 'air_weekday'))}`
          : '（当天没有条目）';
        return [
          line('ok', `返回 ${days.length} 天，星期字段 weekday.cn = ${String(deepGet(days[0], 'weekday.cn'))}`),
          line('info', `当天条目数：${asArray(deepGet(days[0], 'items')).length}`),
          line('info', `样例：${truncate(sample, 160)}`),
          line('info', '注意：air_weekday 是「放送日历归属」，与真实钟点星期可能相差一天'),
        ];
      },
    },
    {
      name: 'search-v0-airdate',
      url: 'https://api.bgm.tv/v0/search/subjects?limit=20&offset=0',
      ext: 'json',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          keyword: '',
          filter: { type: [2], air_date: [`>=${startDate}`, `<${endDate || `${season.year + 1}-01-01`}`] },
        }),
      },
      intent: '能否按 air_date 区间直接拉一整季（这是「当季清单」最省事的拿法），顺带确认 UA 要求',
      inspect: (body) => {
        const json = JSON.parse(body) as unknown;
        const items = asArray(deepGet(json, 'data'));
        if (items.length === 0) {
          return [
            line('fail', 'air_date 过滤返回 0 条 —— 可能 filter 语法不对，或需要换成按 tag/季度检索'),
            line('info', `原始响应片段：${truncate(body, 300)}`),
          ];
        }
        const first = items[0];
        const dates = items.map((i) => String(deepGet(i, 'date') ?? '')).filter(Boolean).sort();
        return [
          line('ok', `返回 ${items.length} 条（total = ${String(deepGet(json, 'total'))}）`),
          line('ok', `日期范围实测：${dates[0]} ~ ${dates[dates.length - 1]}  ← 确认 air_date 过滤被真正执行`),
          line('info', `样例：bgm_id=${String(deepGet(first, 'id'))} name_cn=${String(deepGet(first, 'name_cn'))} eps=${String(deepGet(first, 'eps'))} platform=${String(deepGet(first, 'platform'))}`),
          line('info', `图片与评分字段：images=${typeName(deepGet(first, 'images'))} rating=${typeName(deepGet(first, 'rating'))}`),
        ];
      },
    },
  ];
}

function bangumiDataCases(season: SeasonInfo): ProbeCase[] {
  const range = seasonDateRange(season.id, 20);

  return [
    {
      name: 'dataset',
      url: 'https://unpkg.com/bangumi-data/dist/data.json',
      ext: 'json',
      intent: '社区维护的季度数据集：中文译名、放送时刻（ISO 8601 重复区间）、各平台播放页链接',
      inspect: (body) => {
        const json = JSON.parse(body) as unknown;
        const items = asArray(deepGet(json, 'items'));
        if (items.length === 0) return [line('fail', '没有 items 字段，数据集结构可能已变更')];

        const zhOf = (item: unknown) => asArray(deepGet(item, 'titleTranslate.zh-Hans'));
        const sitesOf = (item: unknown) => asArray(deepGet(item, 'sites'));
        const hasSite = (item: unknown, site: string) => sitesOf(item).some((s) => deepGet(s, 'site') === site);
        const broadcastOf = (item: unknown) => String(deepGet(item, 'broadcast') ?? '');
        const pct = (n: number, total = items.length) => `${n}/${total} (${Math.round((n / total) * 100)}%)`;

        // 只看当季 —— 这些数字才真正决定本项目的实现方式。
        // 区间口径必须与 bangumi-data provider 完全一致（±20 天宽松收纳），否则两边数字对不上。
        const seasonItems = items.filter((item) => {
          const begin = String(deepGet(item, 'begin') ?? '');
          return begin >= range.startUtc && begin < range.endUtc;
        });

        const samples = seasonItems.slice(0, 3).map((item) => {
          const parsed = parseBroadcastInterval(broadcastOf(item));
          const timeText = parsed
            ? `${parsed.startUtc}（JST ${formatInZone(parsed.startUtc, 'jst')}，每 ${parsed.periodDays} 天）`
            : broadcastOf(item) || '无放送时间';
          const sites = sitesOf(item).map((s) => String(deepGet(s, 'site')));
          return `${String(zhOf(item)[0] ?? deepGet(item, 'title'))} | ${timeText} | 平台 ${sites.join('/')}`;
        });

        return [
          line('ok', `数据集共 ${items.length} 条番剧；顶层字段 ${Object.keys(json as object).join(', ')}`),
          line('ok', `带简体中文名 titleTranslate.zh-Hans 的：${pct(items.filter((i) => zhOf(i).length > 0).length)}`),
          line(
            'ok',
            `带 Bangumi 条目 ID 的：${pct(items.filter((i) => hasSite(i, 'bangumi')).length)}  ← 全库中文元数据的锚点`,
          ),
          line('info', `带 AniList ID 的：${pct(items.filter((i) => hasSite(i, 'aniList')).length)}  ← 用来和精确时刻对齐`),
          line('info', `带 B站 链接的（全库）：${pct(items.filter((i) => hasSite(i, 'bilibili')).length)}`),
          line('info', `含重复区间 broadcast 的（全库）：${pct(items.filter((i) => broadcastOf(i).length > 0).length)}`),
          line('ok', `—— 只看当季 ${season.label}（共 ${seasonItems.length} 部）——`),
          line(
            'ok',
            `当季带中文名：${pct(seasonItems.filter((i) => zhOf(i).length > 0).length, seasonItems.length)}`,
          ),
          line(
            'ok',
            `当季带 broadcast（可直接算出日本放送时刻）：${pct(
              seasonItems.filter((i) => parseBroadcastInterval(broadcastOf(i)) !== null).length,
              seasonItems.length,
            )}`,
          ),
          line(
            seasonItems.some((i) => hasSite(i, 'bilibili')) ? 'info' : 'warn',
            `当季带 B站 链接：${pct(seasonItems.filter((i) => hasSite(i, 'bilibili')).length, seasonItems.length)}` +
              `  ← 当季番往往还没公布版权，所以「国内更新时间」必须另从 B站 API 取`,
          ),
          ...samples.map((text, index) => line('info', `当季样例 ${index + 1}：${text}`)),
        ];
      },
    },
  ];
}

function jikanCases(season: SeasonInfo): ProbeCase[] {
  const seasonName = season.aniList.toLowerCase();
  return [
    {
      name: 'season',
      url: `https://api.jikan.moe/v4/seasons/${season.year}/${seasonName}?limit=25`,
      ext: 'json',
      intent: 'MAL 的非官方 API：主要作为广播时刻的兜底源（broadcast.day / broadcast.time）与 MAL ID 对齐',
      inspect: (body) => {
        const json = JSON.parse(body) as unknown;
        const items = asArray(deepGet(json, 'data'));
        if (items.length === 0) return [line('fail', '返回 0 条，季节名或年份可能不对')];
        const withBroadcast = items.filter((i) => deepGet(i, 'broadcast.string') !== undefined).length;
        const first = items[0];
        return [
          line('ok', `返回 ${items.length} 条`),
          line('info', `带 broadcast.string 的：${withBroadcast}/${items.length}`),
          line('info', `样例：${String(deepGet(first, 'title_japanese'))}`),
          line('info', `broadcast 样例：${JSON.stringify(deepGet(first, 'broadcast'))}`),
          line('info', `mal_id=${String(deepGet(first, 'mal_id'))} episodes=${String(deepGet(first, 'episodes'))} aired=${JSON.stringify(deepGet(first, 'aired'))}`),
          line('warn', '限速较严（约 3 请求/秒），只做兜底与校验，不做主力'),
        ];
      },
    },
  ];
}

function bilibiliCases(season: SeasonInfo): ProbeCase[] {
  const headers = {
    referer: 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
  };
  return [
    {
      name: 'timeline',
      url: 'https://api.bilibili.com/pgc/web/timeline?types=1&before=6&after=6',
      ext: 'json',
      init: { headers },
      intent: '番剧时间表：确认能否拿到每个平台的真实更新时间（pub_ts），这是「我几点能看」的答案',
      inspect: (body) => {
        const json = JSON.parse(body) as unknown;
        const code = deepGet(json, 'code');
        if (code !== undefined && code !== 0) {
          return [line('fail', `业务返回码 code=${String(code)} message=${String(deepGet(json, 'message'))}`)];
        }
        const days = asArray(deepGet(json, 'result'));
        if (days.length === 0) return [line('warn', '没有 result 数组，接口可能已变更或需要登录态')];
        const firstEp = asArray(deepGet(days, '0.episodes'))[0];
        return [
          line('ok', `返回 ${days.length} 天的时间表`),
          line('info', `样例：date=${String(deepGet(days, '0.date'))} 条目数=${asArray(deepGet(days, '0.episodes')).length}`),
          line('info', `集样例：title=${String(deepGet(firstEp, 'title'))} pub_ts=${String(deepGet(firstEp, 'pub_ts'))} pub_index=${String(deepGet(firstEp, 'pub_index'))}`),
          line(
            deepGet(firstEp, 'pub_ts') !== undefined ? 'ok' : 'warn',
            'pub_ts 是 unix 秒，可直接作为「国内可看时刻」，务必与日本放送时刻分开显示',
          ),
        ];
      },
    },
  ];
}

function yucCases(season: SeasonInfo): ProbeCase[] {
  const yyyymm = `${season.year}${String(season.month).padStart(2, '0')}`;
  const yymm = `${String(season.year).slice(2)}${String(season.month).padStart(2, '0')}`;

  // 实测结论（2026-10-02）：
  //   - 路径规则确认是 /YYYYMM/（/202610/ = 2026年10月新番表），/2610/ 与 /last/ 均为 404
  //   - HTTPS 证书已过期（CERT_HAS_EXPIRED），只能走 HTTP
  //   - 页面是纯静态服务端渲染的表格，无内嵌 JSON，无需无头浏览器
  //   - 站点实际名称为「長門番堂」，/new/ 是「新番卫星观测站」（已公布未定档）
  return [
    {
      name: 'season-https',
      url: `https://yuc.wiki/${yyyymm}/`,
      ext: 'html',
      intent: '反证：该站 HTTPS 证书已过期，此用例预期失败，用来确认问题是否仍未修复',
      expectFailure: true,
      inspect: (body) => describeHtmlFinding(`/${yyyymm}/ (https)`, summarizeHtml(body)),
    },
    {
      name: `season-${yyyymm}`,
      url: `http://yuc.wiki/${yyyymm}/`,
      ext: 'html',
      intent: `当季表（已确认路径规则为 /YYYYMM/）：http://yuc.wiki/${yyyymm}/`,
      inspect: (body) => describeHtmlFinding(`/${yyyymm}/ (http)`, summarizeHtml(body)),
    },
    {
      name: `season-${yymm}-should-404`,
      url: `http://yuc.wiki/${yymm}/`,
      ext: 'html',
      intent: `反证：/YYMM/ 形式（${yymm}）应当 404，用来确认路径规则用的是四位年份`,
      expectFailure: true,
      inspect: (body) => describeHtmlFinding(`/${yymm}/`, summarizeHtml(body)),
    },
    {
      name: 'upcoming',
      url: 'http://yuc.wiki/new/',
      ext: 'html',
      intent: '「新番卫星观测站」= 已公布但未定档的番剧，可作为「即将开播」提醒的数据来源',
      inspect: (body) => describeHtmlFinding('/new/', summarizeHtml(body)),
    },
  ];
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

const SOURCES: ProbeSource[] = [
  {
    id: 'bangumi-data',
    label: 'bangumi-data 数据集',
    role: '主力①：季度清单 + 中文译名 + 国内平台链接',
    cases: bangumiDataCases(args.season),
  },
  {
    id: 'bangumi',
    label: 'Bangumi API',
    role: '主力②：中文元数据 + 分集列表 + 放送星期',
    cases: bangumiCases(args.season),
  },
  {
    id: 'anilist',
    label: 'AniList GraphQL',
    role: '主力③：每集精确 UTC 放送时刻（日历精确度的生命线）',
    cases: anilistCases(args.season),
  },
  {
    id: 'bilibili',
    label: 'Bilibili PGC',
    role: '主力④：国内真实可看时刻',
    cases: bilibiliCases(args.season),
  },
  {
    id: 'jikan',
    label: 'Jikan (MAL)',
    role: '校验/兜底：broadcast 时刻 + MAL ID',
    cases: jikanCases(args.season),
  },
  {
    id: 'yuc',
    label: 'yuc.wiki',
    role: '校对源：人工校对的当季信息（不是主力，稳定性不足以承担主力）',
    cases: yucCases(args.season),
  },
];

type CaseResult = {
  sourceId: string;
  sourceLabel: string;
  caseName: string;
  intent: string;
  url: string;
  status: number | null;
  finalUrl: string | null;
  bytes: number;
  elapsedMs: number;
  contentType: string;
  savedPath: string | null;
  error: string | null;
  expectFailure: boolean;
  findings: Finding[];
};

/**
 * 可选的代理支持。
 *
 * 为什么需要：实测本机网络下 api.bgm.tv / bgm.tv 的 DNS 被解析到 Facebook 的 IP
 * （69.63.180.173、2a03:2880:...:face:b00c::）——这是典型的 DNS 污染，
 * 表现为连接超时。有代理时设置 HTTPS_PROXY 或 --proxy=... 即可恢复访问。
 *
 * 这里用动态 import，保证「没装依赖也能跑探测脚本」这个特性不被破坏。
 */
let dispatcher: unknown = null;

async function setupProxy(): Promise<void> {
  if (!args.proxy) return;
  try {
    const undici = await import('undici');
    dispatcher = new undici.ProxyAgent(args.proxy);
    console.log(`已启用代理：${args.proxy}\n`);
  } catch (error) {
    console.log(
      `检测到代理 ${args.proxy}，但无法加载 undici（${error instanceof Error ? error.message : String(error)}）。\n` +
        `先运行 pnpm install；被阻断的域名（如 api.bgm.tv）在没有代理时无法访问。\n`,
    );
  }
}

async function runCase(source: ProbeSource, probeCase: ProbeCase): Promise<CaseResult> {
  const startedAt = Date.now();
  const result: CaseResult = {
    sourceId: source.id,
    sourceLabel: source.label,
    caseName: probeCase.name,
    intent: probeCase.intent,
    url: probeCase.url,
    status: null,
    finalUrl: null,
    bytes: 0,
    elapsedMs: 0,
    contentType: '',
    savedPath: null,
    error: null,
    expectFailure: probeCase.expectFailure === true,
    findings: [],
  };

  try {
    const init = {
      ...(probeCase.init ?? {}),
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/json, text/html;q=0.9, */*;q=0.8',
        ...((probeCase.init?.headers as Record<string, string> | undefined) ?? {}),
      },
      signal: AbortSignal.timeout(args.timeoutMs),
      redirect: 'follow',
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit;

    const response = await fetch(probeCase.url, init);

    const body = await response.text();
    result.status = response.status;
    result.finalUrl = response.url;
    result.bytes = Buffer.byteLength(body, 'utf8');
    result.contentType = response.headers.get('content-type') ?? '';
    result.elapsedMs = Date.now() - startedAt;

    if (args.save) {
      const ext = probeCase.ext ?? (result.contentType.includes('html') ? 'html' : 'json');
      const targetDir = path.join(args.dir, source.id);
      mkdirSync(targetDir, { recursive: true });
      const target = path.join(targetDir, `${probeCase.name}.${ext}`);
      const payload = ext === 'json' ? safePrettyJson(body) : body;
      writeFileSync(target, payload, 'utf8');
      result.savedPath = target;
    }

    if (!response.ok) {
      result.findings.push(line('fail', `HTTP ${response.status} ${response.statusText}`));
      result.findings.push(line('info', `响应片段：${truncate(body.replace(/\s+/g, ' '), 200)}`));
      if (response.status === 403) {
        result.findings.push(line('warn', '403 常见于缺 User-Agent 或被风控；本脚本已带 UA，若仍 403 说明需要别的请求头'));
      }
      return result;
    }

    if (probeCase.inspect) {
      try {
        result.findings.push(...probeCase.inspect(body, result.contentType));
      } catch (error) {
        result.findings.push(line('warn', `结构解析失败（不影响快照保存）：${String(error)}`));
        result.findings.push(line('info', `响应片段：${truncate(body.replace(/\s+/g, ' '), 200)}`));
      }
    }
  } catch (error) {
    result.elapsedMs = Date.now() - startedAt;
    const chain = explainError(error);
    result.error = chain[0] ?? String(error);
    result.findings.push(line('fail', `请求失败：${result.error}`));
    for (const item of chain.slice(1)) result.findings.push(line('info', `原因：${item}`));

    const joined = chain.join(' ');
    if (/CERT_HAS_EXPIRED|certificate has expired/i.test(joined)) {
      result.findings.push(line('warn', '证书已过期：该域名无法用 HTTPS 正常访问。要么改走 HTTP，要么为该域名单独放宽 TLS 校验'));
    } else if (/ENOTFOUND|EAI_AGAIN/i.test(joined)) {
      result.findings.push(line('warn', 'DNS 解析失败：域名可能被污染，需要换 DNS 或走代理'));
    } else if (/CONNECT_TIMEOUT|ETIMEDOUT|timeout/i.test(joined)) {
      result.findings.push(
        line(
          'warn',
          '连接超时：若 DNS 解析到明显不相干的 IP（例如 Facebook 的 69.63.180.x / 2a03:2880::face:b00c），即为 DNS 污染 → 需要代理，试 --proxy=http://127.0.0.1:端口',
        ),
      );
    } else if (/ECONNRESET|EPROTO|SSL|TLS/i.test(joined)) {
      result.findings.push(line('warn', '连接被重置或 TLS 握手失败：典型的 SNI 阻断，需要代理'));
    }
  }

  return result;
}

function safePrettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** 把 error.cause 链完整展开 —— fetch 只给一句 "fetch failed"，真正原因几乎总在 cause 里。 */
function explainError(error: unknown): string[] {
  const chain: string[] = [];
  let current: unknown = error;
  let depth = 0;
  while (current && depth < 6) {
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      chain.push(`${current.name}${code ? ` [${code}]` : ''}: ${current.message.replace(/\n/g, ' ')}`);
      current = (current as { cause?: unknown }).cause;
    } else {
      chain.push(String(current));
      break;
    }
    depth += 1;
  }
  return chain;
}

function renderMarkdown(results: CaseResult[], season: SeasonInfo): string {
  const lines: string[] = [];
  lines.push(`# 数据源探测报告`);
  lines.push('');
  lines.push(`- 探测时间：${new Date().toISOString()}`);
  lines.push(`- 目标季度：**${season.label}**（${season.id}，AniList 记法 ${season.aniList} ${season.year}）`);
  lines.push(`- Node：${process.version}`);
  lines.push('');
  lines.push('> 本报告由 `node scripts/probe-sources.ts` 自动生成。');
  lines.push('> 原始响应快照与本报告同目录，可直接用于离线重放解析逻辑。');
  lines.push('');

  const bySource = new Map<string, CaseResult[]>();
  for (const result of results) {
    const list = bySource.get(result.sourceId);
    if (list) list.push(result);
    else bySource.set(result.sourceId, [result]);
  }

  lines.push('## 结论速览');
  lines.push('');
  lines.push('| 数据源 | 用例 | HTTP | 字节 | 耗时 | 结论 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const result of results) {
    const verdict =
      result.error !== null
        ? result.expectFailure
          ? '预期内失败（反证）'
          : '请求失败'
        : result.status !== 200
          ? `HTTP ${result.status}`
          : result.findings.some((f) => f.level === 'fail')
            ? '可用但有阻塞项'
            : '正常';
    lines.push(
      `| ${result.sourceLabel} | ${result.caseName} | ${String(result.status ?? '—')} | ${result.bytes} | ${result.elapsedMs}ms | ${verdict} |`,
    );
  }
  lines.push('');

  for (const [sourceId, list] of bySource) {
    const first = list[0];
    lines.push(`## ${first?.sourceLabel ?? sourceId}`);
    lines.push('');
    for (const result of list) {
      lines.push(`### \`${result.caseName}\``);
      lines.push('');
      lines.push(`- 请求：\`${result.url}\``);
      if (result.finalUrl && result.finalUrl !== result.url) lines.push(`- 最终地址：\`${result.finalUrl}\``);
      lines.push(`- 状态：${String(result.status ?? '—')} · ${result.bytes} 字节 · ${result.elapsedMs}ms`);
      if (result.savedPath) lines.push(`- 快照：\`${result.savedPath}\``);
      lines.push(`- 探测意图：${result.intent}`);
      lines.push('');
      for (const finding of result.findings) {
        lines.push(`- ${ICON[finding.level]} ${finding.text}`);
      }
      lines.push('');
    }
  }

  lines.push('## 怎么用这份报告');
  lines.push('');
  lines.push('1. 逐条看上面的结论，它们直接决定 Phase 1 的抓取器怎么写。');
  lines.push('2. 稳定结论请回填到 `docs/sources.md`（那份文件是给未来的你和未来的我看的）。');
  lines.push('3. 同目录下的原始响应快照可以离线重放：解析逻辑写错时，不必再打源站。');
  lines.push('');
  lines.push('## 判读要点');
  lines.push('');
  lines.push('- **`预期内失败（反证）`** 不等于故障：例如用 HTTPS 访问 yuc.wiki 是故意去证明它证书过期。');
  lines.push('- **`ConnectTimeout` + DNS 解析到不相干的 IP** = DNS 污染，需要代理，不是源站的问题。');
  lines.push('- **覆盖率类结论**（例如 AniList 的 airingSchedule 比例）决定了哪个源当主力、哪个当兜底。');
  lines.push('- **快照里的字节数**能反推该源的维护活跃度：数据量突然变小往往意味着源站出事了。');
  lines.push('');

  return lines.join('\n');
}

async function main(): Promise<void> {
  const selected = args.only ? SOURCES.filter((s) => args.only?.has(s.id)) : SOURCES;

  console.log(`\x1b[1m数据源探测 · ${args.season.label}（${args.season.id}）\x1b[0m`);
  console.log(`node ${process.version} · 超时 ${args.timeoutMs}ms · 快照目录 ${args.save ? args.dir : '（未开启）'}`);
  if (args.only) console.log(`仅探测：${[...args.only].join(', ')}`);
  console.log('');

  await setupProxy();

  const results: CaseResult[] = [];

  for (const source of SOURCES) {
    if (!selected.includes(source)) continue;
    console.log(`\x1b[1m${source.label}\x1b[0m  \x1b[90m${source.role}\x1b[0m`);

    for (const probeCase of source.cases) {
      process.stdout.write(`  ${probeCase.name} … `);
      const result = await runCase(source, probeCase);
      results.push(result);

      const headline = result.findings[0];
      const statusText = result.status === null ? '无响应' : `HTTP ${result.status}`;
      console.log(`${statusText} ${result.bytes}B ${result.elapsedMs}ms`);
      for (const finding of result.findings) {
        console.log(`    ${COLOR[finding.level]}${ICON[finding.level]}\x1b[0m ${finding.text}`);
      }
      if (!headline && !result.error) console.log('    · 无附加结论');
    }
    console.log('');
  }

  if (args.save) {
    mkdirSync(args.dir, { recursive: true });
    const reportPath = path.join(args.dir, 'report.md');
    writeFileSync(reportPath, renderMarkdown(results, args.season), 'utf8');
    console.log(`${'─'.repeat(64)}`);
    console.log(`报告已写入：${reportPath}`);
    console.log(`原始快照：${args.dir}`);
  }

  const allBad = results.filter((r) => r.error !== null || r.status !== 200);
  const expected = allBad.filter((r) => r.expectFailure);
  const failed = allBad.filter((r) => !r.expectFailure);
  const healthy = results.length - allBad.length;
  const warned = results.filter(
    (r) => !r.expectFailure && r.findings.some((f) => f.level === 'warn' || f.level === 'fail'),
  );

  console.log('');
  console.log(
    `共 ${results.length} 个用例：${healthy} 个 HTTP 正常，${failed.length} 个待解决，` +
      `${expected.length} 个预期内失败（反证用例），${warned.length} 个带告警。`,
  );

  if (expected.length > 0) {
    console.log('');
    console.log('预期内的失败（作为反证存在，不算问题）：');
    for (const result of expected) {
      console.log(`  - ${result.sourceLabel} / ${result.caseName}：${result.error ?? `HTTP ${result.status}`}`);
    }
  }

  if (failed.length > 0) {
    console.log('');
    console.log('待解决的用例（这些会直接决定对应功能能不能做）：');
    for (const result of failed) {
      console.log(`  - ${result.sourceLabel} / ${result.caseName}：${result.error ?? `HTTP ${result.status}`}`);
    }
  }

  console.log('');
  console.log('下一步：把 report.md 里的逐条结论回填到 docs/sources.md，再按那里的结论写正式抓取器。');
}

await main();
