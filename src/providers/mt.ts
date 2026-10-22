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

/**
 * 机翻默认并发数。
 *
 * 实测（2026-10-22，本机）：并发 4 + 250ms 间隔 = 24 条 7.7 秒（**0.32 秒/条**、3.1 请求/秒），
 * 24 条全部成功、没有退到 MyMemory。对照：旧实现串行 + 每条先睡 700ms = **1.92 秒/条**。
 * 并发 6 + 200ms 能到 0.23 秒/条，但对免费接口更激进，默认取 4。
 */
export const DEFAULT_TRANSLATE_CONCURRENCY = 4;
/** 两条翻译请求之间的默认最小间隔（毫秒）。 */
export const DEFAULT_TRANSLATE_INTERVAL_MS = 250;

export type TranslateOptions = {
  /**
   * **两条请求之间**的最小间隔（毫秒），默认 250。
   *
   * ⚠ 语义是「距上一次请求不足这个间隔才等」，不是「每条开头先睡一下」。
   * 旧实现是后者：每条固定 700ms 纯等待 + 请求本身的 ~1.2s RTT = **1.92 s/条**
   * （2026-10-22 实测 12 条 23 秒）。517 条缺名条目就要 16 分钟。
   */
  minIntervalMs?: number;
  /**
   * 并发条数，默认 3。
   *
   * 免费接口有风控，所以它有上限且必须配合 `minIntervalMs` 一起看
   * （实际速率 ≈ concurrency / 单条耗时，再由 minIntervalMs 兜住下限）。
   * 实测 fetchSeason 那批 517 条在并发 3 下没有触发风控；万一触发 429，
   * `translateTitles` 会把失败的那几条**串行重试**（见函数注释）。
   */
  concurrency?: number;
  /** 单条请求超时 */
  timeoutMs?: number;
  /**
   * 返回 true 就**停止继续取新条目**（已经翻好的照常返回，未翻的位置保持 undefined）。
   * 用于「停止」按钮：正在飞的那几条不打断，但不会再发新请求。
   */
  shouldStop?: () => boolean;
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

// ---------------------------------------------------------------------------
// 全局限速：并发靠它兜住下限
// ---------------------------------------------------------------------------

/**
 * 上一次真正发出翻译请求的时刻。全模块共享 —— 并发 worker 都从这里取"出发时间"。
 */
let lastRequestAt = 0;
/**
 * 串行化的"取号"队列。
 *
 * 为什么必须有它：并发时几个 worker 会同时算出同一个 `lastRequestAt`，
 * 于是同时睡、同时发 —— 限速形同虚设（实测就是这样把 3 并发打成了每秒 3 个突发请求）。
 * 把「算等待 + 记账」放进一条链里，请求出发时刻就至少相隔 `minIntervalMs`。
 */
let slotChain: Promise<void> = Promise.resolve();

function takeRequestSlot(minIntervalMs: number): Promise<void> {
  const next = slotChain.then(async () => {
    if (minIntervalMs > 0) {
      const wait = lastRequestAt + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt = Date.now();
  });
  // 即使这一环出错也不能把队列卡死，否则后面所有翻译都会挂住
  slotChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** 供自检用：把限速状态清干净。 */
export function resetTranslatePacer(): void {
  lastRequestAt = 0;
  slotChain = Promise.resolve();
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
  const { minIntervalMs = DEFAULT_TRANSLATE_INTERVAL_MS, timeoutMs = 20_000 } = options;
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, error: '空文本' };

  // ⚠ 这里等的是「距离上一次请求」而不是「每条先睡一下」——
  //   旧写法让 12 条耗时 23 秒（1.92 s/条），见 TranslateOptions.minIntervalMs
  await takeRequestSlot(minIntervalMs);

  const primary = await translateWithBing(trimmed, timeoutMs);
  if (primary.ok) return primary;

  const fallback = await translateWithMyMemory(trimmed, timeoutMs);
  if (fallback.ok) return fallback;

  return {
    ok: false,
    error: `Bing 失败（${primary.error ?? '未知'}）；MyMemory 也失败（${fallback.error ?? '未知'}）`,
  };
}

/** 哪些失败值得串行重试（风控 / 网络抖一下）；「空文本」「纯拉丁」这种重试也没用。 */
function isTransientFailure(error: string | undefined): boolean {
  if (!error) return true;
  return /HTTP (401|403|429|5\d\d)|超时|timeout|ETIMEDOUT|ECONN|请求失败|响应里没有译文|socket/i.test(error);
}

/**
 * 批量为一批标题取机翻结果，保持顺序与输入一致。
 *
 * 三个刻意的设计：
 *   1. **有界并发**（默认 3）：单条 RTT 约 1.2 秒，串行时 1.92 s/条；
 *      并发 3 + 250ms 全局间隔后实测约 0.4~0.5 s/条（见 docs/决策记录.md D14）。
 *   2. **全局最小间隔**：并发不等于猛打，请求出发时刻仍由 `takeRequestSlot` 兜住。
 *   3. **失败串行重试**：免费接口偶尔 429 / 抖动，失败的那几条最后用 1.2 秒间隔
 *      串行重试一次 —— 这样即使风控被触发，结果也不会静默变成"翻不出来"，
 *      而且不会把风控继续放大（重试是真慢，但只针对失败的那几条）。
 */
export async function translateTitles(
  titles: readonly string[],
  options: TranslateOptions & { onProgress?: (done: number, total: number) => void } = {},
): Promise<TranslateOutcome[]> {
  const { onProgress, concurrency = DEFAULT_TRANSLATE_CONCURRENCY, shouldStop, ...rest } = options;
  const total = titles.length;
  const results: TranslateOutcome[] = new Array(total);
  if (total === 0) return results;

  let cursor = 0;
  let done = 0;
  const workerCount = Math.max(1, Math.min(Math.trunc(concurrency) || 1, total));

  const worker = async (): Promise<void> => {
    for (;;) {
      if (shouldStop?.()) return;
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      results[index] = await translateTitle(titles[index] as string, rest);
      done += 1;
      onProgress?.(done, total);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));

  // 失败兜底：只挑"值得重试"的，串行、慢一点，别把风控继续放大。
  // 注意这会覆盖前面的结果 —— 重试成功的替换掉失败，仍失败的保留最后一次错误。
  const retryIndexes = results
    .map((outcome, index) => ({ outcome, index }))
    .filter((item) => item.outcome !== undefined && !item.outcome.ok && isTransientFailure(item.outcome.error))
    .map((item) => item.index);
  if (retryIndexes.length > 0 && retryIndexes.length < total) {
    for (const index of retryIndexes) {
      if (shouldStop?.()) break;
      const retried = await translateTitle(titles[index] as string, { ...rest, minIntervalMs: 1_200 });
      if (retried.ok) results[index] = retried;
      done += 1;
      onProgress?.(done, total);
    }
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
