/**
 * 网络诊断：定位「某个域名抓不到」到底是哪一层出的问题。
 *
 *   node scripts/diagnose-network.ts
 *   node scripts/diagnose-network.ts --dns-order=ipv4first
 *
 * 为什么要单独有这个脚本：
 * 在国内网络环境下，抓取失败的原因往往是 DNS 污染、IPv6 不可达、
 * TLS 握手被中间设备重置，而不是「网站挂了」。这三种情况的处理方式完全不同，
 * 而 fetch 默认只给一句 "fetch failed"，把真正原因藏在 error.cause 里。
 * 本脚本会把 cause 链完整打出来，并对比 IPv4/IPv6 的差别。
 */

import { lookup } from 'node:dns/promises';
import { setDefaultResultOrder } from 'node:dns';

const TARGETS = [
  'https://api.bgm.tv/calendar',
  'https://bgm.tv/',
  'https://yuc.wiki/',
  'https://graphql.anilist.co',
  'https://api.bilibili.com/pgc/web/timeline?types=1&before=1&after=1',
  'https://api.jikan.moe/v4/seasons/now',
  'https://unpkg.com/bangumi-data/dist/data.json',
];

const args = process.argv.slice(2);
const dnsOrder = args.find((a) => a.startsWith('--dns-order='))?.slice('--dns-order='.length);

if (dnsOrder === 'ipv4first' || dnsOrder === 'verbatim' || dnsOrder === 'ipv6first') {
  setDefaultResultOrder(dnsOrder);
  console.log(`DNS 解析顺序已设为：${dnsOrder}\n`);
}

/** 把 error.cause 链完整展开 —— 真正的原因几乎总在 cause 里。 */
function explainError(error: unknown): string[] {
  const chain: string[] = [];
  let current: unknown = error;
  let depth = 0;
  while (current && depth < 6) {
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      chain.push(`${current.name}${code ? ` [${code}]` : ''}: ${current.message}`);
      current = (current as { cause?: unknown }).cause;
    } else {
      chain.push(String(current));
      break;
    }
    depth += 1;
  }
  return chain;
}

function hintFor(text: string): string | null {
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return 'DNS 解析失败：域名被污染或本地 DNS 不可用 → 换 DNS 或走代理';
  if (/ECONNREFUSED/.test(text)) return '连接被拒绝：本机可能有防火墙/代理拦截';
  if (/ECONNRESET|EPIPE|socket hang up/.test(text)) return '连接被重置：典型的 SNI 阻断/中间设备干扰 → 需要代理';
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|timeout/i.test(text)) return '连接超时：目标不可达或被丢包 → 需要代理';
  if (/CERT|certificate|self.signed|UNABLE_TO_VERIFY/.test(text)) return '证书校验失败：可能是中间人劫持或站点证书过期';
  if (/EPROTO|SSL|TLS/.test(text)) return 'TLS 握手失败：多见于 SNI 阻断 → 需要代理';
  if (/fetch failed/.test(text)) return '通用失败：看上面 cause 链的具体错误码';
  return null;
}

console.log('网络诊断\n');

for (const target of TARGETS) {
  const host = new URL(target).host;
  console.log(`\x1b[1m${target}\x1b[0m`);

  // 1) DNS
  for (const family of [4, 6] as const) {
    try {
      const records = await lookup(host, { family, all: true });
      const addresses = records.map((r) => r.address).slice(0, 4);
      console.log(`  DNS(v${family})  \x1b[32m✓\x1b[0m ${addresses.join(', ')}${records.length > 4 ? ` …共 ${records.length} 条` : ''}`);
    } catch (error) {
      const chain = explainError(error);
      console.log(`  DNS(v${family})  \x1b[90m·\x1b[0m ${chain[0]?.split('\n')[0] ?? '无记录'}`);
    }
  }

  // 2) 实际请求
  const startedAt = Date.now();
  try {
    const response = await fetch(target, {
      headers: { 'user-agent': 'anime-tracker/0.1 (network diagnosis)' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
    const body = await response.text();
    console.log(
      `  HTTP      \x1b[${response.ok ? '32' : '33'}m${response.status}\x1b[0m ${body.length} 字节 ${Date.now() - startedAt}ms  →  ${response.url}`,
    );
  } catch (error) {
    const chain = explainError(error);
    console.log(`  HTTP      \x1b[31m✗\x1b[0m ${Date.now() - startedAt}ms`);
    for (const item of chain) {
      console.log(`      ${item.replace(/\n/g, ' ')}`);
    }
    const hint = hintFor(chain.join(' '));
    if (hint) console.log(`      \x1b[33m→ ${hint}\x1b[0m`);
  }

  console.log('');
}

console.log('提示：如果只有个别域名失败，通常是该域名在你所在网络被阻断；');
console.log('如果全部失败，检查系统代理设置，或试 `node scripts/diagnose-network.ts --dns-order=ipv4first`。');
