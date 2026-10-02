/**
 * yuc.wiki Provider —— 校对源（走 HTTP）。
 *
 * 实测结构（2026-10-02，页面 166KB）：
 *   站点实名「長門番堂」，当季表地址是 /YYYYMM/（如 http://yuc.wiki/202610/）。
 *   **HTTPS 证书已过期，只能走 HTTP。** 页面是纯静态服务端渲染的 HTML，无内嵌 JSON。
 *
 * 页面同时给出同一批番的两种表示，各自带不同的信息，需要合起来看：
 *
 *   A. 详细区（69 块，由 <!--#Cxx--> 注释分隔）
 *      <p class="title_cn_r">转生成为魔剑 第2期</p>    ← 中文名
 *      <p class="title_jp_r">転生したら剣でしたⅡ</p>     ← 日文原名（跨源匹配的关键）
 *      <td class="staff_r1">…动画制作：C2C</td>          ← 制作公司
 *      <td class="type_tag_r">转生/奇幻/冒险</td>          ← 类型标签
 *      <p class="broadcast_r">10/7周三深夜</p>            ← 人工标注的放送时段
 *
 *   B. 按天网格（71 块，<div class="div_date">）
 *      <p class="imgtext4">25:00~</p>                    ← 精确时刻，24 小时制字面写法 ★
 *      <p class="imgep2">10/7~</p>                       ← 首播日期
 *      <td class="date_title_">转生成为魔剑<br>第2期</td>  ← 中文名
 *      <a href="平台链接"><p class="area">港台</p></a>     ← 平台 + 区域
 *
 * 为什么它值得保留为校对源：
 *   `imgtext4` 给的是 **"25:00" 这种字面写法**，正好是「日本放送日历 vs 真实钟点」
 *   这个歧义的原始表述 —— 不需要像 bangumi-data 那样从 UTC 时刻反推。
 *   再加上它按天排列，放送日历归属是显式给出的。
 *
 * 解析用正则而不是 cheerio：页面是静态生成的，结构规整；
 * 但**必须带结构性校验**（解析出的条目数太少就直接报错），否则源站改版会静默产出空数据。
 */

import type { SeasonInfo } from '../core/time.ts';
import { resolveAiringSlot } from '../core/time.ts';
import type { MediaType, Platform, RawEpisode, RawSeasonAnime } from '../core/types.ts';
import { fetchText } from './http.ts';
import type { Provider } from './provider.ts';

/** 解析出的条目少于这个数就认为页面结构变了（当季正常有 60+ 部）。 */
const MIN_EXPECTED_ENTRIES = 20;

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

function textOf(fragment: string | undefined): string {
  if (!fragment) return '';
  return fragment
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** 中文名里常有换行（为了排版），归一成一行并去掉空格。 */
function flatTitle(raw: string): string {
  return raw.replace(/\s*\n\s*/g, '').trim();
}

/** 取第一个匹配的捕获组。 */
function firstMatch(html: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(html);
  return match?.[1];
}

// ---------------------------------------------------------------------------
// 平台
// ---------------------------------------------------------------------------

/**
 * 平台识别靠链接域名而不是图标 URL。
 *
 * 页面上的平台图标是 <img> 且文件名是哈希，无法直接看出是哪家；
 * 但外层 <a href> 指向该平台的页面，域名是稳定可靠的信号。
 */
const PLATFORM_BY_DOMAIN: ReadonlyArray<readonly [RegExp, string]> = [
  [/bilibili\.com\/bangumi|bilibili\.com\/video/i, '哔哩哔哩'],
  [/bilibili\.com\/anime/i, '哔哩哔哩（港澳台）'],
  [/bilibili\.tv/i, 'bilibili（台湾）'],
  [/gamer\.com\.tw/i, '巴哈姆特動畫瘋'],
  [/iqiyi\.com/i, '爱奇艺'],
  [/v\.qq\.com|film\.qq\.com/i, '腾讯视频'],
  [/youku\.com/i, '优酷'],
  [/mgtv\.com/i, '芒果TV'],
  [/mytvsuper\.com/i, 'myTV SUPER'],
  [/viu\.com/i, 'Viu'],
  [/muse.*(hk|tw)|muse-?communication/i, '木棉花'],
  [/ani-?one|anione/i, 'ANiONE'],
  [/netflix\.com/i, 'Netflix'],
  [/crunchyroll\.com/i, 'Crunchyroll'],
  [/acfun\.cn/i, 'AcFun'],
];

function platformNameOf(href: string): string | undefined {
  for (const [pattern, name] of PLATFORM_BY_DOMAIN) {
    if (pattern.test(href)) return name;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// A 区：详细块
// ---------------------------------------------------------------------------

type DetailBlock = {
  titleCn?: string;
  titleOriginal?: string;
  mediaTypeHint: string;
  genres: string[];
  studios: string[];
  /** 形如 "10/7周三深夜" */
  broadcastNote?: string;
  coverUrl?: string;
  siteUrl?: string;
};

function parseDetailBlocks(html: string): DetailBlock[] {
  const blocks: DetailBlock[] = [];

  /*
   * 切分方式的选择（踩过的坑）：
   * 一开始按 <!--#Cxx--> 注释切，结果只切出 24 块 —— 因为那个标记只加在前 24 部「重点番」上，
   * 其余 45 部在没有任何标记的大块里。而 title_main_r 实际有 69 个。
   *
   * 可靠的分隔符是每个详细块的开头：`<div style="float:left"><img width="180px" …>`。
   * 注意按天网格里的块也用 `float:left`，但图宽是 120px，所以用 180px 过滤即可区分。
   */
  const chunks = html.split(/<div style="float:left">/).filter((chunk) => /width="180px"/.test(chunk));

  for (const chunk of chunks) {
    // 只处理含标题结构的块
    if (!/class="title_(?:cn|jp)_r/.test(chunk)) continue;

    const titleCnRaw = firstMatch(chunk, /class="title_cn_r\d*"[^>]*>([\s\S]*?)<\/p>/i);
    const titleJpRaw = firstMatch(chunk, /class="title_jp_r\d*"[^>]*>([\s\S]*?)<\/p>/i);

    const titleCn = titleCnRaw ? flatTitle(textOf(titleCnRaw)) : undefined;
    const titleOriginal = titleJpRaw ? flatTitle(textOf(titleJpRaw)) : undefined;
    if (!titleCn && !titleOriginal) continue;

    const staffText = textOf(firstMatch(chunk, /class="staff_r\d*"[^>]*>([\s\S]*?)<\/td>/i));
    const studios = [...staffText.matchAll(/动画制作[：:]\s*([^\n]+)/g)]
      .map((match) => (match[1] ?? '').trim())
      .filter(Boolean);

    const genreText = textOf(firstMatch(chunk, /class="type_tag_r"[^>]*>([\s\S]*?)<\/td>/i));
    const genres = genreText
      .split(/[/、\n]/)
      .map((genre) => genre.trim())
      .filter((genre) => genre.length > 0 && genre.length < 12);

    const mediaTypeHint = textOf(firstMatch(chunk, /class="type_c_r"[^>]*>([\s\S]*?)<\/td>/i));
    const broadcastNote = textOf(firstMatch(chunk, /class="broadcast_r"[^>]*>([\s\S]*?)<\/p>/i)) || undefined;

    // 封面：详细块前面的 180px 图
    const coverUrl = firstMatch(chunk, /<img[^>]*width="180px"[^>]*data-src="([^"]+)"/i);
    const siteUrl = firstMatch(chunk, /<a href="([^"]+)"[^>]*>\s*动画官网/i);

    blocks.push({
      ...(titleCn ? { titleCn } : {}),
      ...(titleOriginal ? { titleOriginal } : {}),
      mediaTypeHint,
      genres,
      studios,
      ...(broadcastNote ? { broadcastNote } : {}),
      ...(coverUrl ? { coverUrl } : {}),
      ...(siteUrl ? { siteUrl } : {}),
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// B 区：按天网格（给出精确时刻与平台）
// ---------------------------------------------------------------------------

type GridEntry = {
  titleCn: string;
  /** 字面放送时刻，如 "25:00" */
  hhmmJst?: string;
  /** 首播日期，形如 "10/7" */
  dateMd?: string;
  coverUrl?: string;
  platforms: Platform[];
};

function parseGridEntries(html: string): GridEntry[] {
  const entries: GridEntry[] = [];
  const chunks = html.split(/<div class="div_date"/).slice(1);

  for (const chunk of chunks) {
    const titleRaw = firstMatch(chunk, /class="date_title__?"[^>]*>([\s\S]*?)<\/td>/i);
    if (!titleRaw) continue;
    const titleCn = flatTitle(textOf(titleRaw));
    if (!titleCn) continue;

    const timeRaw = textOf(firstMatch(chunk, /class="imgtext4"[^>]*>([\s\S]*?)<\/p>/i));
    const hhmmMatch = /^(\d{1,2}):(\d{2})/.exec(timeRaw);
    const hhmmJst = hhmmMatch ? `${String(Number(hhmmMatch[1])).padStart(2, '0')}:${hhmmMatch[2]}` : undefined;

    const dateRaw = textOf(firstMatch(chunk, /class="imgep2?"[^>]*>([\s\S]*?)<\/p>/i));
    const dateMatch = /^(\d{1,2})\/(\d{1,2})/.exec(dateRaw);
    const dateMd = dateMatch
      ? `${String(Number(dateMatch[1])).padStart(2, '0')}/${String(Number(dateMatch[2])).padStart(2, '0')}`
      : undefined;

    const coverUrl = firstMatch(chunk, /<img[^>]*width="120px"[^>]*data-src="([^"]+)"/i);

    // 平台：从外链域名识别，区域文字（大陆/港台）作为补充说明
    const platforms: Platform[] = [];
    for (const match of chunk.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = match[1] ?? '';
      const name = platformNameOf(href);
      if (!name) continue;
      const area = textOf(firstMatch(match[2] ?? '', /class="area"[^>]*>([\s\S]*?)<\/p>/i));
      const label = area && !name.includes(area) ? `${name}（${area}）` : name;
      if (!platforms.some((platform) => platform.name === label)) {
        platforms.push({ name: label, url: href });
      }
    }

    entries.push({
      titleCn,
      ...(hhmmJst ? { hhmmJst } : {}),
      ...(dateMd ? { dateMd } : {}),
      ...(coverUrl ? { coverUrl } : {}),
      platforms,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

function mapMediaType(hint: string): MediaType {
  if (/剧场|电影/.test(hint)) return 'MOVIE';
  if (/OVA|OAD|特别篇/.test(hint)) return 'OVA';
  if (/网络|WEB/.test(hint)) return 'WEB';
  if (/TV|电视/.test(hint)) return 'TV';
  return 'TV';
}

/** 标题归一化：只用于 A/B 两区之间的配对。 */
function pairingKey(title: string): string {
  return title
    .normalize('NFKC')
    .replace(/[\s\u3000]/g, '')
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[·・、,，.。!！?？~～\-—–:：;；'"“”‘’]/g, '')
    .toLowerCase();
}

/**
 * 由「月/日 + 字面时刻」解出真实 UTC 时刻。
 *
 * 年分需要推断：10 月表上出现 "9/26" 是本年，1 月表上出现 "12/28" 则是上一年。
 */
function resolveYear(month: number, day: number, season: SeasonInfo): number {
  const seasonStart = Date.UTC(season.year, season.month - 1, 1);
  const candidate = Date.UTC(season.year, month - 1, day);
  const DAY = 86_400_000;
  if (candidate > seasonStart + 200 * DAY) return season.year - 1;
  return season.year;
}

export function parseYucSeasonPage(html: string, season: SeasonInfo): RawSeasonAnime[] {
  const details = parseDetailBlocks(html);
  const grid = parseGridEntries(html);

  if (details.length + grid.length < MIN_EXPECTED_ENTRIES) {
    throw new Error(
      `yuc.wiki 页面解析结果异常：详细块 ${details.length} 个、网格 ${grid.length} 个，` +
        `低于预期（${MIN_EXPECTED_ENTRIES}）。页面结构很可能已改版 —— ` +
        `请用 node scripts/probe-sources.ts --only=yuc 抓一份新快照对照。`,
    );
  }

  const detailByTitle = new Map<string, DetailBlock>();
  for (const detail of details) {
    if (detail.titleCn) detailByTitle.set(pairingKey(detail.titleCn), detail);
  }

  /**
   * 配对兜底：归一化后不完全相等时，允许「一方包含另一方」——
   * 但要保证候选唯一，避免把两部不同的番配到一起。
   */
  const findByPrefix = (title: string): DetailBlock | undefined => {
    const key = pairingKey(title);
    if (key.length < 4) return undefined;
    const candidates = details.filter((detail) => {
      if (!detail.titleCn) return false;
      const other = pairingKey(detail.titleCn);
      return other.length >= 4 && (other.includes(key) || key.includes(other));
    });
    return candidates.length === 1 ? candidates[0] : undefined;
  };

  const usedDetails = new Set<string>();
  const result: RawSeasonAnime[] = [];

  for (const entry of grid) {
    const key = pairingKey(entry.titleCn);
    const detail = detailByTitle.get(key) ?? findByPrefix(entry.titleCn);
    if (detail?.titleCn) usedDetails.add(pairingKey(detail.titleCn));

    const titleOriginal = detail?.titleOriginal;
    const sourceId = titleOriginal ?? entry.titleCn;

    // 由「月/日 + 字面时刻」解出精确时刻与放送日历归属
    let firstAirAtUtc: string | undefined;
    let broadcastWeekdayJst: number | undefined;
    let broadcastTimeJst = entry.hhmmJst;

    if (entry.dateMd && entry.hhmmJst) {
      const [monthText, dayText] = entry.dateMd.split('/');
      const month = Number(monthText);
      const day = Number(dayText);
      if (Number.isFinite(month) && Number.isFinite(day)) {
        const year = resolveYear(month, day, season);
        const broadcastDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const slot = resolveAiringSlot(broadcastDate, entry.hhmmJst);
        firstAirAtUtc = slot.airAtUtc;
        broadcastWeekdayJst = slot.broadcastWeekdayJst;
        broadcastTimeJst = slot.hhmmJst;
      }
    }

    const episodes: RawEpisode[] = firstAirAtUtc
      ? [{ epNumber: 1, airAtUtc: firstAirAtUtc, source: 'yuc' }]
      : [];

    const platforms: Platform[] = [...entry.platforms];
    if (detail?.siteUrl) {
      platforms.push({ name: '动画官网', url: detail.siteUrl });
    }

    result.push({
      source: 'yuc',
      sourceId,
      titleCn: entry.titleCn,
      ...(titleOriginal ? { titleOriginal } : {}),
      // 日文原名进别名，让「B站译名 / 原名」都能搜到
      aliases: titleOriginal ? [titleOriginal, entry.titleCn] : [entry.titleCn],
      ...(entry.coverUrl ?? detail?.coverUrl ? { coverUrl: entry.coverUrl ?? detail?.coverUrl } : {}),
      mediaType: mapMediaType(detail?.mediaTypeHint ?? ''),
      // yuc 不给集数，交给 AniList / bangumi-data
      studios: detail?.studios ?? [],
      genres: detail?.genres ?? [],
      status: 'unknown',
      ...(firstAirAtUtc ? { firstAirAtUtc } : {}),
      ...(broadcastWeekdayJst === undefined ? {} : { broadcastWeekdayJst }),
      ...(broadcastTimeJst ? { broadcastTimeJst } : {}),
      platforms,
      episodes,
    });
  }

  // 详细区里有、但网格里没配上的（例如已完结或未定档的），单独补进来 ——
  // 它们仍然能贡献中文名与日文原名，这对跨源匹配很有价值。
  for (const detail of details) {
    if (!detail.titleCn) continue;
    if (usedDetails.has(pairingKey(detail.titleCn))) continue;
    result.push({
      source: 'yuc',
      sourceId: detail.titleOriginal ?? detail.titleCn,
      titleCn: detail.titleCn,
      ...(detail.titleOriginal ? { titleOriginal: detail.titleOriginal } : {}),
      aliases: detail.titleOriginal ? [detail.titleOriginal, detail.titleCn] : [detail.titleCn],
      ...(detail.coverUrl ? { coverUrl: detail.coverUrl } : {}),
      mediaType: mapMediaType(detail.mediaTypeHint),
      studios: detail.studios,
      genres: detail.genres,
      status: 'unknown',
      platforms: detail.siteUrl ? [{ name: '动画官网', url: detail.siteUrl }] : [],
      episodes: [],
    });
  }

  return result;
}

// ---------------------------------------------------------------------------

export const yucProvider: Provider = {
  id: 'yuc',
  label: 'yuc.wiki（校对）',
  capabilities: ['season', 'platforms'],

  async fetchSeason(season: SeasonInfo): Promise<RawSeasonAnime[]> {
    // 路径规则实测为 /YYYYMM/（四位年份）；HTTPS 证书已过期，只能走 HTTP
    const yyyymm = `${season.year}${String(season.month).padStart(2, '0')}`;
    const url = `http://yuc.wiki/${yyyymm}/`;

    const response = await fetchText(url, {
      timeoutMs: 30_000,
      retries: 1,
      minIntervalMs: 1_000,
      userAgent: 'anime-tracker/0.1 (season list, low rate)',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });

    if (response.status === 404) {
      // 下一季的页面往往还没建，这属于正常情况，不该让整个同步失败
      console.warn(`[yuc] ${url} 返回 404（该季度页面还没建），跳过`);
      return [];
    }
    if (!response.ok) {
      throw new Error(`yuc.wiki 返回 HTTP ${response.status}：${url}`);
    }

    return parseYucSeasonPage(response.text, season);
  },
};
