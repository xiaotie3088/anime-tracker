# 数据源实测结论（Phase 0）

- 实测时间：2026-10-02（目标季度：**2026 秋 / 2026-10**）
- 实测环境：Windows / Node v24.18.0 / 本机时区 UTC+8
- 复现命令：`node scripts/probe-sources.ts`
- 原始响应快照：`data/probe-2026-10-02T07-55-10-475Z/`（7.8MB 的 bangumi-data 快照也在里面，可离线重放解析）
- 网络诊断：`node scripts/diagnose-network.ts`

> 本文档里的每个数字都来自真实响应，不是推测。凡未实测的都标了「未验证」。

---

## 一、结论速览

| 数据源 | 实测结果 | 在本项目中的最终定位 |
|---|---|---|
| **bangumi-data** | ✅ HTTP 200，7.8MB，8897 条 | **主力①**：中文译名 + 放送时刻 + 国内平台 + 跨源 ID 锚点 |
| **AniList** | ✅ HTTP 200，当季 104 部 | **主力②**：每集精确 UTC 放送时刻 + 分集列表 + 制作/类型 |
| **Bilibili PGC** | ✅ HTTP 200，13 天时间表 | **主力③**：国内真实可看时刻（`pub_ts`）—— 尚未接入代码 |
| **yuc.wiki** | ✅ HTTP 200（走 HTTP），80 条 | **校对源**：字面放送时刻（`25:00`）+ 放送日历归属 + 制作公司 |
| **Jikan (MAL)** | ⚠️ HTTP 504（上游 MAL 不稳） | 兜底（不能当主力） |
| **Bangumi API** | ❌ 连接超时（DNS 被污染） | 需要代理才能用；暂缓接入 |

---

## 二、bangumi-data（主力①，已验证可用）

**地址**：`https://unpkg.com/bangumi-data/dist/data.json` → 实际解析到 `bangumi-data@0.3.228`

**实测数字**

| 指标 | 全库（8897 条） | 只看 2026 秋（64 部） |
|---|---|---|
| 带简体中文名 `titleTranslate["zh-Hans"]` | 8376 (94%) | **61/64 = 95%** |
| 带 `broadcast`（可算出放送时刻） | 1915 (22%) | **64/64 = 100%** |
| 带 Bangumi 条目 ID（跨源锚点） | 8833 (99%) | — |
| 带 AniList ID | 8298 (93%) | — |
| 带 B站 链接 | 3207 (36%) | **0/64 = 0%** |

> 全库平均 22% 的 `broadcast` 覆盖率看起来很糟，但那是被 1960–2000 年代的老番拉低的；
> **当季覆盖率是 100%** —— 对这个项目而言，这才是真正有意义的数字。

**结构（实测，顶层 `{ siteMeta, items }`）**

```
item = {
  title: "鉄腕アトム",                       // 原名（日文）
  titleTranslate: {                          // 注意：值是「字符串数组」，不是字符串
    "zh-Hans": ["铁臂阿童木", "原子小金刚", ...],
    "zh-Hant": [...], en: [...], ja: [...]
  },
  type: "tv" | "web" | "ova" | "movie",
  lang: "ja",
  begin: "1962-12-31T16:00:00.000Z",         // 首播精确时刻（UTC）
  broadcast: "R/1962-12-31T16:00:00.000Z/P7D", // ISO 8601 重复区间 ← 关键
  end:   "1966-12-30T16:00:00.000Z",          // 完结时刻（924/8897 条为空字符串，非 null）
  comment: "...",
  sites: [ { site: "bangumi", id: "806" }, { site: "bilibili", id: "..." }, ... ]
}
siteMeta = { bilibili: { title, urlTemplate: "https://.../{{id}}", type }, ... }
```

**关键发现**

1. **`broadcast` 是 ISO 8601 重复区间**，不是「每周四 23:00」这种字符串：
   `R/2026-10-07T15:00:00.000Z/P7D` = 从该 UTC 时刻起每 7 天一次。
   → 直接给出日本放送时刻，**且配合 `end` 能推出整部番每一集的时刻**。
2. **`sites[].id` 可能缺失**（85783 个 site 条目里有 28 个没有 `id`，多为爱奇艺条目）。
   第一版 schema 写成必填，直接导致 provider 报错 —— 已修正为可选。
3. 平台标识共 **38 种**，含地区变体：`bilibili` / `bilibili_tw` / `bilibili_hk_mo` / `bilibili_hk_mo_tw` /
   `acfun` / `iqiyi` / `youku` / `qq` / `mgtv` / `mytv` / `viu` / `muse_hk` / `muse_tw` /
   以及资源站 `dmhy`（动漫花园）/ `mikan`（蜜柑计划）/ `acgnx`。
4. **当季番的 B站 链接为 0**：版权通常要等开播前后才公布。
   → 结论：**国内更新时间不能指望这个数据集，必须直接问 B站 API**。
5. `end` 为空时是空字符串 `""`，不是 `null` —— 判空时两者都要处理。

**实现约束（已落地在 `src/providers/bangumi-data.ts`）**

- 数据集 7.8MB，**落盘缓存 12 小时**，避免每次同步都拉全库。
- 落盘保存**原始响应文本**，保证离线可重放。
- 只暴露国内（含港澳台）平台，日本流媒体不入库（否则每部番挂 5~8 个平台，纯噪音）。
- 由 `broadcast`+`end` 推算分集；没有 `end` 时只给第 1 集，其余交给 AniList。

---

## 三、AniList（主力②，已验证可用）

**地址**：`https://graphql.anilist.co`，POST GraphQL，无需 API Key

**实测数字（2026 秋，page 1 of perPage=50）**

| 指标 | 实测 |
|---|---|
| 当季条目 | 104 部（分页共 3 页） |
| 有 `airingSchedule`（每集 UTC 时刻） | **47/50 = 94%** |
| 有 `nextAiringEpisode` | 94% |
| 有 `idMal` | **100%** |
| 有 `title.native` | 100% |
| 有中文标题 `title.chinese` | **0%**（该字段不存在） |
| `externalLinks` 里有 B站 | 0% |

**结论**

- `airingSchedule` 94% 的覆盖率**足以承担「日历精确到分钟」这个职责**，
  剩下 6% 由 bangumi-data 的 weekly 区间兜住（当季 broadcast 覆盖率 100%）。
  两个源在这一点上正好互补 —— 这是多源设计最直接的收益。
- 它**没有中文名**，也没有国内平台，所以必须和 bangumi-data 融合。
- GET 请求会返回 404，这是正常的 —— 它只接受 POST。

---

## 四、Bilibili PGC（主力③，已验证可用）

**地址**：`https://api.bilibili.com/pgc/web/timeline?types=1&before=6&after=6`
（需 `Referer: https://www.bilibili.com`）

**实测**：HTTP 200，30824 字节，178ms，返回 13 天时间表

```
result[].date = "9-26"
result[].episodes[] = { title: "小车队大救援：自然护卫队", pub_ts: 1790388000, pub_index: "第5话" }
```

**结论**

- `pub_ts` 是 unix 秒，**就是你在 B站几点能点开看的时间**。
- 必须与日本放送时刻**分开存储、分开展示** —— 两者通常差几小时到一天。
- 注意：这不是「当季新番清单」的接口，它只是「近期更新表」，
  所以角色是「给已经匹配到的番补上国内时间」，而不是发现新番。

---

## 五、Jikan / MAL（兜底）

- 第一次探测：**HTTP 504**，响应内容明确写着上游 MyAnimeList 连不上：
  `"Jikan failed to connect to MyAnimeList. MyAnimeList may be down/unavailable"`
- `https://api.jikan.moe/v4/seasons/now` 单独探测时返回 200 / 101KB，说明是间歇性故障。

**结论**：Jikan 是免费的非官方代理，稳定性不可控。**只能当最后兜底，不能作主力**。
限速也严（约 3 请求/秒）。

---

## 六、Bangumi API（❌ 当前网络不可达）

`https://api.bgm.tv/calendar` 与 `https://bgm.tv/` 均**连接超时**。

**诊断（`node scripts/diagnose-network.ts`）**：

```
DNS(v4)  69.63.180.173
DNS(v6)  2a03:2880:f134:83:face:b00c:0:25de
HTTP     ✗ ConnectTimeoutError (attempted 69.63.180.173:443, ... timeout: 10000ms)
```

`69.63.180.x` 与 `2a03:2880::/32` 都是 **Facebook/Meta 的网段**，而 `face:b00c` 更是标志性地址。
这是**典型的 DNS 污染**，不是源站故障。

**对策（已实现）**：设置代理即可恢复。`src/providers/http.ts` 使用 undici 并默认读取
`HTTPS_PROXY` / `ALL_PROXY` 环境变量：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
node src/server/cli.ts season
```

**影响评估**：可以接受。中文元数据已由 bangumi-data 提供（当季 95%），
Bangumi API 主要价值在「更准确的分集数 / 制作公司 / 标签」，属于增强项而非阻塞项。

---

## 七、yuc.wiki（校对源，定位得到实测支持）

**站点实名**：長門番堂

**实测结果**

| 地址 | 结果 |
|---|---|
| `https://yuc.wiki/202610/` | ❌ `CERT_HAS_EXPIRED`（证书已过期） |
| `http://yuc.wiki/202610/` | ✅ HTTP 200，190921 字节，158 个 table，**430 个数据行** |
| `http://yuc.wiki/2610/` | ❌ HTTP 404（Tencent EdgeOne 错误页） |
| `http://yuc.wiki/new/` | ✅ HTTP 200，77996 字节，113 行 —— 标题「**新番卫星观测站**」 |

**已确认的事实**

1. **URL 规则是 `/YYYYMM/`**（四位年份）：`/202610/` = 「2026年10月新番表」。`/2610/`、`/last/` 均 404。
2. **HTTPS 证书已过期，只能走 HTTP**。站点挂在 Tencent EdgeOne 后面。
3. 页面是**纯静态服务端渲染的表格**，无内嵌 JSON（无 `__NEXT_DATA__`），
   **不需要无头浏览器**，`cheerio`/正则即可解析。
4. 按天排列：星期表头为 `周一 (月) / 周二 (火) / … / 周日 (日)`。
5. 关键词命中：`新番`、`版权`、`制作`、`放送`、`动画`、**`bilibili`**。
6. **最有价值的发现**：每条番剧的备注里带有人工标注的放送时段，
   形如 **`10/8周四深夜`**、**`10/4周日晚间`**、`10/6周二深夜`、`10/3周六早间`。
   这恰好是**放送日历归属**的权威表述 —— 正是我们解决深夜番歧义最需要的信息，
   而且它比 bangumi-data 的 UTC 时刻更贴近日本排期表的原意。
7. `/new/`（新番卫星观测站）= 已公布但未定档的番剧，
   可以作为「即将开播」提醒的数据来源（额外功能点）。

**页面结构（实测，接入解析器时逐条确认过）**

同一个页面里有两套并行的表示，各自带不同信息，必须合起来看：

```
A. 详细区（69 块，每块以 <div style="float:left"><img width="180px" …> 开头）
   <p class="title_cn_r">转生成为魔剑 第2期</p>        ← 中文名
   <p class="title_jp_r">転生したら剣でしたⅡ</p>         ← 日文原名（跨源匹配的关键）
   <td class="staff_r1">…动画制作：C2C</td>              ← 制作公司
   <td class="type_tag_r">转生/奇幻/冒险</td>             ← 类型标签
   <p class="broadcast_r">10/7周三深夜</p>               ← 人工标注的放送时段

B. 按天网格（71 块，<div class="div_date">）
   <p class="imgtext4">25:00~</p>                       ← 精确时刻，24 小时制字面写法 ★
   <p class="imgep2">10/7~</p>                          ← 首播日期
   <td class="date_title_">转生成为魔剑<br>第2期</td>     ← 中文名
   <a href="平台链接"><p class="area">港台</p></a>        ← 平台 + 区域
```

**解析结果（用离线快照实测）**：80 条，其中中文名 80、日文原名 69、字面放送时刻 65、
首播时刻 65、平台 76、制作公司 69、类型标签 66。

**为什么它值得保留为校对源**：`imgtext4` 给的是 **`25:00` 这种字面写法** ——
这正是「日本放送日历 vs 真实钟点」这个歧义的原始表述，不需要像 bangumi-data 那样
从 UTC 时刻反推。而且它按天排列，放送日历归属是显式给出的。

实测样例：`魔法少女育成计画restart` 标记为「周一 25:30」→ 解析为 UTC `2026-10-05T16:30Z`
→ JST 真实钟点 `01:30`（周二凌晨）。与 `core/time.ts` 的 `resolveAiringSlot()` 完全一致。

**三个解析坑（都踩过）**

1. 一开始按 `<!--#Cxx-->` 注释切分详细块，只切出 24 块 —— 因为那个标记只加在
   前 24 部「重点番」上，其余 45 部在没有任何标记的大块里。
   可靠的分隔符是每个详细块开头的 `width="180px"`（按天网格的图是 120px，可据此区分）。
2. 平台名**不能从图标 URL 识别**（文件名是哈希），必须靠外层 `<a href>` 的域名
   （`acg.gamer.com.tw` → 巴哈姆特動畫瘋）。`<p class="area">` 给的是区域（大陆/港台），
   可以拼成「巴哈姆特動畫瘋（港台）」这种更清楚的展示名。
3. 详细区里 A 与 B 的标题写法不同（`转生成为魔剑 第2期` vs 换行版的 `转生成为魔剑第2期`），
   配对前必须归一化（去空格、去标点、去括号内容）。

**解析器的防改版设计**：解析结果少于 20 条就直接抛错，而不是静默返回空数据 ——
源站改版时必须"响亮地失败"，否则会以为"这季没番"。

**为什么最终定位为「校对源」而不是主力**（对应方案报告里的判断，现在有实测支撑）

- HTTPS 证书过期 —— 一个连证书都没维护的站点，不适合承担主干数据。
- 没有 API、没有 SLA、单一维护者。
- 158 个 table 里混着页面顶部的**手办广告表格**，解析需要针对性处理，脆弱。
- 但它的人工标注（放送时段、版权平台、备注）**质量高于自动抓取**，
  所以正确用法是：**拿它校对和补漏，而不是当唯一来源**。

**实现约束**：走 `http://` 即可（HTTPS 因证书过期而不可用）；
`http.ts` 里保留了按请求放宽 TLS 的能力（`allowInsecureTls`），但当前不需要用到，
更不会全局关闭证书校验。

---

## 八、网络环境问题汇总（这些不是源站的错）

| 现象 | 根因 | 对策 |
|---|---|---|
| `api.bgm.tv` / `bgm.tv` 连接超时 | DNS 污染到 Facebook 网段 | 设置 `HTTPS_PROXY`（已实现） |
| `yuc.wiki` HTTPS 失败 | 站点证书真的过期了 | 走 HTTP，或对该域名单独放宽 TLS |
| Jikan 504 | 上游 MAL 不稳 | 只做兜底，且失败要能降级 |
| PowerShell/curl 全部失败但 Node 正常 | PowerShell 走 schannel，受限环境拿不到凭证 | **用 Node 做网络诊断**，别用 curl 下结论 |

> 最后一条是本次实测踩到的坑：`Invoke-WebRequest` 与 `curl.exe` 全部报
> `schannel: AcquireCredentialsHandle failed`，但 Node 的 fetch/undici 完全正常。
> 所以判断「某个源能不能访问」必须用 Node 复现，否则会得出完全错误的结论。

---

## 九、三源融合后的实际效果（2026 秋实测）

原始条目 64（bangumi-data）+ 80（yuc）+ 104（AniList）= 248 条，**融合后 123 部，融合掉 125 条重复，
且可能重复的标题组为 0**（说明按 ID 锚点 + 标题归一化的聚类是干净的）。

覆盖度对比（接入 yuc 之前 → 之后）：

| 字段 | 只有 2 源 | 加上 yuc 后 |
|---|---|---|
| 中文名 | 61 / 107 | **84 / 123** |
| 放送时刻 | 77 | 77 |
| 制作公司 | — | **108** |
| 类型标签 | — | **111** |
| 播放平台 | 82 | 82（新增 巴哈姆特動畫瘋 / 动画官网） |

字段来源分布（证明字段级优先级按设计生效，不是"谁后写谁覆盖"）：

```
titleCn              bangumi-data=61  yuc=23
titleOriginal        bangumi-data=64  anilist=43  yuc=6
broadcastTimeJst     yuc=65           bangumi-data=12
broadcastWeekdayJst  yuc=65           anilist=39   bangumi-data=12
studios              anilist=98       yuc=10
genres               anilist=103      yuc=8
```

读法：中文名优先 bangumi-data、不够时 yuc 补；**字面放送时刻与放送日历归属以 yuc 为主**
（它是显式标注的）；制作公司与类型以 AniList 为主（覆盖更全）。这正是多源设计想要的结果。

---

## 十、最终分工（已落地）

| 职责 | 主源 | 兜底 |
|---|---|---|
| 当季清单 | bangumi-data + AniList | yuc.wiki |
| 中文译名 / 别名 | bangumi-data（95%） | yuc.wiki |
| 跨源 ID 锚点 | bangumi-data 的 `sites[]` | AniList 的 `idMal` |
| 每集精确时刻 | AniList（94%） | bangumi-data 的 weekly 区间（100%） |
| 国内可看时刻 | Bilibili API | yuc.wiki 的人工标注 |
| 制作公司 / 类型标签 | AniList | Bangumi API（需代理） |
| 已公布未定档 | yuc.wiki `/new/` | — |

**字段级优先级**见 `src/core/merge.ts` 的 `FIELD_PRIORITY`。

---

## 十一、仍未验证的部分

- [ ] B站 PGC 的「番剧索引」接口（用于按季度发现番剧）—— 本次只验证了 timeline。
- [ ] Bilibili 是否有 wbi 签名要求、频控阈值具体多少（需要持续观察）。
- [ ] Bangumi API 在代理下的实际结构与限速（当前网络无法验证）。
- [ ] yuc.wiki 表格的完整列顺序与「版权平台」是文字还是图标（快照里 `bilibili` 关键词命中，
      但需在写解析器时逐行确认）。
- [ ] AniList 的 `airingSchedule` 对「未定档」番的表现。

> 这些不影响当前进度：主力三源已验证可用，日历的核心能力（精确到分钟 + 深夜番正确归属）已经能跑通。
