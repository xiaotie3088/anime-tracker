/**
 * HTTP 基础设施：统一 User-Agent、按域名限速、超时、重试、代理、定向放宽 TLS。
 *
 * 为什么不用全局 fetch 而要引 undici：
 *   1. **代理**：Node 的全局 fetch 不读 HTTPS_PROXY。
 *      而实测本机网络中 api.bgm.tv / bgm.tv 的 DNS 被污染到 Facebook 的 IP
 *      （69.63.180.173 / 2a03:2880:...:face:b00c::），表现为连接超时，
 *      国内用户想用 Bangumi 基本都得走代理。这是硬需求，不是可选优化。
 *   2. **定向放宽 TLS**：yuc.wiki 的 HTTPS 证书已过期（实测 CERT_HAS_EXPIRED），
 *      只能走 HTTP 或对该域名单独关闭证书校验 —— 但绝不能全局关掉。
 *
 * 限速是默认行为而非可选项：Bangumi 要求自定义 UA，B站 有风控，
 * 抓取器被封锁会直接导致整个软件失效。
 */

import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import type { Dispatcher } from 'undici';

const DEFAULT_USER_AGENT =
  'anime-tracker/0.1 (+https://github.com/your-name/anime-tracker; personal use, low rate)';

/** 每个域名的最近一次请求时间戳，用于全局限速。 */
const lastHitByHost = new Map<string, number>();

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 调度器（dispatcher）
// ---------------------------------------------------------------------------

/** 从环境变量或传入参数解析代理地址。 */
export function resolveProxyUrl(explicit?: string | null): string | null {
  return (
    explicit ??
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    null
  );
}

let proxyDispatcher: Dispatcher | null = null;
let proxyUrlUsed: string | null = null;
let insecureDispatcher: Dispatcher | null = null;

/** 取得（并缓存）代理调度器。设置了代理时才创建。 */
export function getProxyDispatcher(explicit?: string | null): Dispatcher | null {
  const url = resolveProxyUrl(explicit);
  if (!url) return null;
  if (proxyDispatcher && proxyUrlUsed === url) return proxyDispatcher;
  proxyDispatcher = new ProxyAgent(url);
  proxyUrlUsed = url;
  return proxyDispatcher;
}

/**
 * 仅用于「证书已过期/自签名」的站点的调度器。
 * 全局关闭证书校验是危险做法，所以它必须显式按请求开启。
 */
export function getInsecureDispatcher(): Dispatcher {
  insecureDispatcher ??= new Agent({ connect: { rejectUnauthorized: false } });
  return insecureDispatcher;
}

// ---------------------------------------------------------------------------

export type FetchTextOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** 失败重试次数（仅对网络错误与 429/5xx 生效） */
  retries?: number;
  /** 同一域名两次请求的最小间隔 */
  minIntervalMs?: number;
  /** 覆盖默认 UA */
  userAgent?: string;
  /** 显式指定代理；不传则读 HTTPS_PROXY / ALL_PROXY 等环境变量 */
  proxyUrl?: string | null;
  /**
   * 放宽该次请求的 TLS 证书校验。
   * 只对「已知证书有问题」的站点使用（当前仅 yuc.wiki），且这些请求都是只读公开页面。
   */
  allowInsecureTls?: boolean;
};

export type FetchTextResult = {
  url: string;
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
  /** 从发起到收到响应的毫秒数 */
  elapsedMs: number;
};

async function throttle(url: string, minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  const host = new URL(url).host;
  const last = lastHitByHost.get(host) ?? 0;
  const wait = last + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastHitByHost.set(host, Date.now());
}

/** 把 undici 的错误链整理成一行可读的原因，便于日志排查。 */
export function describeFetchError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  let depth = 0;
  while (current && depth < 5) {
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      parts.push(`${current.name}${code ? `[${code}]` : ''}: ${current.message.replace(/\n/g, ' ')}`);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
    depth += 1;
  }
  return parts.join(' ← ');
}

/**
 * 抓取文本。默认 1.5 秒/域名、20 秒超时、失败重试 2 次。
 * HTTP 错误状态码通过 ok/status 返回，由调用方决定如何处理；网络层失败才抛异常。
 */
export async function fetchText(url: string, options: FetchTextOptions = {}): Promise<FetchTextResult> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 20_000,
    retries = 2,
    minIntervalMs = 1_500,
    userAgent = DEFAULT_USER_AGENT,
    proxyUrl,
    allowInsecureTls = false,
  } = options;

  const dispatcher = allowInsecureTls ? getInsecureDispatcher() : getProxyDispatcher(proxyUrl);

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await throttle(url, minIntervalMs);
    const startedAt = Date.now();
    try {
      const response = await undiciFetch(url, {
        method,
        headers: {
          'user-agent': userAgent,
          accept: 'application/json, text/html;q=0.9, */*;q=0.8',
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
        ...(dispatcher ? { dispatcher } : {}),
      });

      const text = await response.text();
      const result: FetchTextResult = {
        url: response.url || url,
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        text,
        elapsedMs: Date.now() - startedAt,
      };

      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1_000 * 2 ** attempt;
        await sleep(backoff);
        continue;
      }

      return result;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(1_000 * 2 ** attempt);
        continue;
      }
    }
  }

  throw new Error(
    `请求失败（已重试 ${retries} 次）：${url}\n原因：${describeFetchError(lastError)}` +
      (getProxyDispatcher(proxyUrl) ? '' : '\n提示：该域名若被 DNS 污染，请设置 HTTPS_PROXY 或传入 proxyUrl'),
  );
}

/** 抓取并解析 JSON，带上更友好的错误信息。 */
export async function fetchJson<T = unknown>(url: string, options: FetchTextOptions = {}): Promise<T> {
  const result = await fetchText(url, options);
  if (!result.ok) {
    throw new Error(`HTTP ${result.status}：${url}\n响应片段：${result.text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(result.text) as T;
  } catch {
    throw new Error(`响应不是合法 JSON：${url}\n响应片段：${result.text.slice(0, 300)}`);
  }
}

/** 发送 JSON POST（AniList GraphQL、Bangumi 搜索都用这个）。 */
export async function postJson<T = unknown>(
  url: string,
  payload: unknown,
  options: FetchTextOptions = {},
): Promise<T> {
  return fetchJson<T>(url, {
    ...options,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: JSON.stringify(payload),
  });
}
