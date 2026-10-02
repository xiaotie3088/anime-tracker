/**
 * 临时机翻译名 provider。
 *
 * 为什么需要它（用户诉求）：「有些番没中文译名，能否对原名机翻，加『临时机翻译名』；
 * 官方译名出来后一键更新改成官方名」。
 *
 * 为什么是这个方案 —— 实测结论（见 docs/sources.md 第十一节，别重测）：
 *   - Google 系全部超时（本机无代理，且 DNS 不可达）；
 *   - `edge.microsoft.com/translate/auth` 已下线（404）；
 *   - `api.cognitive.microsofttranslator.com` 需要订阅密钥（405）；
 *   - **`cn.bing.com` 的 token 方案可用**，而且质量明显最好；
 *   - MyMemory 可用但质量差，只当兜底。
 *
 * 两个实现细节决定了「一次会话翻一批」而不是「一条一抓」：
 *   1. 拿 token 要下载约 **627KB** 的 HTML 页面（实测）；
 *   2. token 的有效期约 1 小时（响应里第三个值是 TTL 毫秒，实测 3600000）。
 *   所以 token 必须在进程内缓存复用，并且翻译循环里只发小的 POST。
 *
 * 定位是**兜底**：机翻出来的专有名词会错（实测「マゼンチュ」→「马森楚」），
 * 所以结果一律标成 `title_cn_source = 'machine'`，官方译名一出现就被替换。
 */

import { fetchText, sleep } from './http.ts';
import { saveSnapshot } from './snapshot.ts';

const BING_HTML_URL = 'https://cn.bing.com/translator';
const BING_TRANSLATE_URL = 'https://cn.bing.com/ttranslatev3';
const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';

/** 单条翻译的结果来源，用于报告与排查。 */
export type MtEngine = 'bing' | 'mymemory';

export type TranslateOutcome = {
  ok: boolean;
  text?: string;
  engine?: MtEngine;
  error?: string;
};

export type TranslateOptions = {
  /** 两条之间的间隔，默认 700ms（实测 18 条 31 秒不触发风控） */
  minIntervalMs?: number;
  /** 单条请求超时 */
  timeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Bing：token 获取与缓存
// ---------------------------------------------------------------------------

type BingSession = {
  key: string;
  token: string;
  ig: string;
  iid: string;
  expiresAt: number;
};

let session: BingSession | null = null;
let sessionPromise: Promise<BingSession> | null = null;

/** 解析 `params_AbusePreventionHelper = [key,"token",ttl]`。 */
export function parseBingHelper(html: string): { key: string; token: string; ttlMs: number } | null {
  const raw = /params_AbusePreventionHelper\s*=\s*\[([^\]]*)\]/.exec(html)?.[1];
  if (!raw) return null;
  const parts = raw.split(',');
  if (parts.length < 2) return null;
  const key = (parts[0] ?? '').replace(/["'\s]/g, '');
  const token = (parts[1] ?? '').replace(/["'\s]/g, '');
  const ttlMs = Number((parts[2] ?? '').replace(/["'\s]/g, ''));
  if (key === '' || token === '') return null;
  return { key, token, ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 3_600_000 };
}

/** 从页面里取 IG / IID，缺了也能请求（但带上更稳）。 */
export function parseBingIds(html: string): { ig: string; iid: string } {
  return {
    ig: /IG\s*:\s*"([^"]+)"/.exec(html)?.[1] ?? '',
    iid: /data-iid="([^"]+)"/.exec(html)?.[1] ?? '',
  };
}

/** 解析 ttranslatev3 的响应。结构实测为 `[{ translations:[{text}], ... }, {...}]`。 */
export function parseBingTranslation(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const first = Array.isArray(parsed) ? (parsed[0] as { translations?: Array<{ text?: string }> }) : undefined;
    const text = first?.translations?.[0]?.text;
    return typeof text === 'string' && text.trim() !== '' ? text.trim() : null;
  } catch {
    return null;
  }
}

/** 拿一个新的 Bing 会话（页面 627KB，所以只在过期时才抓）。 */
async function createBingSession(timeoutMs: number): Promise<BingSession> {
  const page = await fetchText(BING_HTML_URL, {
    timeoutMs,
    retries: 1,
    // 这个页面只在 token 过期时才抓一次，没必要再额外限速
    minIntervalMs: 300,
    headers: { accept: 'text/html,application/xhtml+xml' },
  });
  if (!page.ok) throw new Error(`Bing 翻译页返回 HTTP ${page.status}`);

  const helper = parseBingHelper(page.text);
  if (!helper) {
    throw new Error('Bing 翻译页里找不到 params_AbusePreventionHelper —— 页面结构可能已改版');
  }
  const { ig, iid } = parseBingIds(page.text);

  return {
    key: helper.key,
    token: helper.token,
    ig,
    iid,
    // 留 60 秒余量，避免边界上刚好过期
    expiresAt: Date.now() + Math.max(60_000, helper.ttlMs - 60_000),
  };
}

/** 取得可用的会话：有效则复用，过期或首次则抓取（并发调用只抓一次）。 */
async function getBingSession(timeoutMs: number): Promise<BingSession> {
  if (session && session.expiresAt > Date.now()) return session;
  sessionPromise ??= createBingSession(timeoutMs)
    .then((fresh) => {
      session = fresh;
      return fresh;
    })
    .finally(() => {
      sessionPromise = null;
    });
  return sessionPromise;
}

/** 供自检 / 调试重置 token 缓存。 */
export function resetMtSession(): void {
  session = null;
  sessionPromise = null;
}

/** 用 Bing 翻一条。失败返回 ok:false（调用方会退到 MyMemory）。 */
export async function translateWithBing(text: string, timeoutMs = 20_000): Promise<TranslateOutcome> {
  try {
    const current = await getBingSession(timeoutMs);
    const query = new URLSearchParams(
      current.ig ? { isVertical: '1', IG: current.ig, ...(current.iid ? { IID: current.iid } : {}) } : {},
    ).toString();

    const body = new URLSearchParams({
      fromLang: 'ja',
      text,
      to: 'zh-Hans',
      token: current.token,
      key: current.key,
    }).toString();

    const response = await fetchText(`${BING_TRANSLATE_URL}?${query}`, {
      method: 'POST',
      body,
      timeoutMs,
      retries: 1,
      minIntervalMs: 0,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        referer: BING_HTML_URL,
        origin: 'https://cn.bing.com',
      },
    });

    if (!response.ok) {
      // 401/403 通常意味着 token 失效 —— 丢掉缓存，下次重新抓
      if (response.status === 401 || response.status === 403) session = null;
      return { ok: false, engine: 'bing', error: `HTTP ${response.status}` };
    }

    const translated = parseBingTranslation(response.text);
    if (!translated) return { ok: false, engine: 'bing', error: '响应里没有译文' };
    return { ok: true, text: translated, engine: 'bing' };
  } catch (error) {
    return { ok: false, engine: 'bing', error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// MyMemory：兜底
// ---------------------------------------------------------------------------

/** MyMemory 单次查询的文本上限（超了会返回错误或截断）。 */
const MYMEMORY_MAX_CHARS = 480;

/**
 * 用 MyMemory 翻一条。
 *
 * 质量明显差于 Bing（实测），而且免费额度有限，所以只在 Bing 挂掉时用。
 * 长文本会按 `MYMEMORY_MAX_CHARS` 分段，逐段翻再拼起来。
 */
export async function translateWithMyMemory(text: string, timeoutMs = 20_000): Promise<TranslateOutcome> {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += MYMEMORY_MAX_CHARS) {
    chunks.push(text.slice(index, index + MYMEMORY_MAX_CHARS));
  }

  const pieces: string[] = [];
  for (const chunk of chunks) {
    try {
      const url = `${MYMEMORY_URL}?q=${encodeURIComponent(chunk)}&langpair=${encodeURIComponent('ja|zh-CN')}`;
      const response = await fetchText(url, {
        timeoutMs,
        retries: 1,
        minIntervalMs: 0,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return { ok: false, engine: 'mymemory', error: `HTTP ${response.status}` };

      const parsed = JSON.parse(response.text) as { responseData?: { translatedText?: string } };
      const translated = parsed.responseData?.translatedText?.trim();
      if (!translated) return { ok: false, engine: 'mymemory', error: '响应里没有译文' };
      pieces.push(translated);
    } catch (error) {
      return { ok: false, engine: 'mymemory', error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { ok: true, text: pieces.join(''), engine: 'mymemory' };
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 翻一条番剧标题：先 Bing，失败退 MyMemory。
 *
 * 刻意不抛异常 —— 一条翻译失败不该中断「一键更新数据」这种批处理，
 * 调用方只需要看 ok 与 error，然后把失败的条目报告出来。
 */
export async function translateTitle(text: string, options: TranslateOptions = {}): Promise<TranslateOutcome> {
  const { minIntervalMs = 700, timeoutMs = 20_000 } = options;
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, error: '空文本' };

  if (minIntervalMs > 0) await sleep(minIntervalMs);

  const primary = await translateWithBing(trimmed, timeoutMs);
  if (primary.ok) return primary;

  const fallback = await translateWithMyMemory(trimmed, timeoutMs);
  if (fallback.ok) return fallback;

  return {
    ok: false,
    error: `Bing 失败（${primary.error ?? '未知'}）；MyMemory 也失败（${fallback.error ?? '未知'}）`,
  };
}

/**
 * 批量为一批标题取机翻结果，保持顺序与输入一致。
 *
 * 逐条串行 + 固定间隔是刻意的：这些是**免费无鉴权**的接口，
 * 并发只会更快地被风控（实测结论见 docs/sources.md）。
 */
export async function translateTitles(
  titles: readonly string[],
  options: TranslateOptions & { onProgress?: (done: number, total: number) => void } = {},
): Promise<TranslateOutcome[]> {
  const { onProgress, ...rest } = options;
  const results: TranslateOutcome[] = [];
  for (const [index, title] of titles.entries()) {
    results.push(await translateTitle(title, rest));
    onProgress?.(index + 1, titles.length);
  }
  return results;
}

/**
 * 把一次机翻批量结果存成快照。
 *
 * 好处与其它抓取一致（见决策记录 T6）：出问题时可以离线回放，
 * 不用再打源站的免费额度；也能看出「这个词以前翻成什么」。
 */
export async function saveTranslationSnapshot(payload: unknown, kind = 'titles'): Promise<string | null> {
  try {
    const meta = await saveSnapshot('mt', kind, JSON.stringify(payload, null, 2), { prettyJson: false });
    return meta.path;
  } catch {
    // 快照失败不该影响翻译结果本身
    return null;
  }
}
