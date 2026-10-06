# 新番追番日历

**当季新番自动汇总 · 追番管理 · 更新日历 · 补番库**

本地优先的单机工具：数据存在你自己的 SQLite 里，不需要注册任何账号，没有云同步。

[![Node](https://img.shields.io/badge/Node-%E2%89%A522.18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-2-brightgreen)]()
[![Build](https://img.shields.io/badge/build-none-orange)]()
[![License](https://img.shields.io/badge/license-not%20set-lightgrey)]()

---

## 它解决什么问题

每季新番有 100 多部，散落在各个网站：**中文名在一处、放送时刻在另一处、国内什么时候能看在第三处**。
想知道"这周我追的番哪天几点更新"，通常得开好几个页面自己拼。

这个工具把它们抓下来融合进一个本地库，然后回答四个问题：

- 这季有什么？→ **全季总览**（可筛选：放送星期 / 媒体类型 / 类型标签 / 国内平台）
- 这周几点更新？→ **周视图**（带倒计时，手机日历也能导入）
- 我追的看到哪了？→ **我的追番**（进度、补番库）
- 它改档了吗？→ **变更**（延期 / 改档检测）

---

## 界面

> 📷 截图见下方。**（替换说明见文末「附：怎么加截图」）**

**周视图** —— 一周七天铺开，每格是当天更新的番：海报、第几话、放送时刻、倒计时。
左上角切换「按真实钟点 / 按日本放送日历」两种口径（见下面「深夜番」那节）。今天那一列会高亮。

**全季总览** —— 顶部是本季统计；`筛选 / 排序` 面板可按放送星期、媒体类型（TV / 剧场版 / OVA…）、
类型标签（动作 / 奇幻 / 科幻…）、国内平台（动画官网 / 巴哈姆特 / Crunchyroll…）多选筛选，
选项旁标着各部数；排序可按首集放送时间、中文名、集数等；**每行几部也能调**（3~7 部）。
季度标签支持**多选**，可以一次看几季的合集。

<!-- 截图放好后把下面这行取消注释：
![周视图与全季总览](screenshots/overview.png)
-->

**我的追番 / 补番库** —— 四个分类（追番中 / 补番库 / 已看完 / 已弃番）。
补番库会显示「5/24，还剩 19 集，约 7 小时 36 分」。

**详情卡** —— 每一集的确切放送时刻，以及**每个字段分别来自哪个数据源**。
数据源打架时会标「源有分歧」，手动改过的标「手动修正」。

---

## 快速开始

### 环境要求

- **Node.js ≥ 22.18**（本机用 24 开发；`node:sqlite` 需要较新的 Node）
- **pnpm**（没有的话用 `npm install` 也一样）

### 三步跑起来

```bash
git clone https://github.com/xiaotie3088/anime-tracker.git
cd anime-tracker
pnpm install          # ← 必须先做，否则会报 Cannot find package 'zod'
```

然后启动：

```bash
node src/server/server.ts
# 浏览器打开 http://127.0.0.1:8787
# 首次进入是空库，点右上角「更新数据」抓当季
```

**Windows 桌面端**（可选，日常使用更方便）：

双击 `desktop\创建桌面快捷方式.cmd`（只需一次），之后双击桌面上的「新番追番日历」即可。
它直接调用浏览器 exe 启动，不依赖系统的 `http://` 关联。

> ⚠️ 桌面快捷方式同样**需要先跑过 `pnpm install`**。

---

## 装了什么依赖

只有 **2 个运行时依赖**，没有构建步骤（Node 直接跑 `.ts`）：

| 依赖 | 用途 |
|---|---|
| `zod` | 校验源站响应结构 —— 源站改版时**早失败**，而不是把脏数据写进库 |
| `undici` | 全局 `fetch` 不读 `HTTPS_PROXY`，而 Bangumi 在国内必须走代理 |

开发依赖只有 `typescript` 和 `@types/node`。**没有** webpack / vite / babel / ESLint / 测试框架。

---

## 数据从哪来

三个源做**字段级融合**（不是简单拼接，参见 `src/core/merge.ts` 的字段优先级）：

| 源 | 提供 |
|---|---|
| [bangumi-data](https://github.com/bangumi-data/bangumi-data) | 中文名、放送时刻 |
| [yuc.wiki](http://yuc.wiki) | 人工校对过的当季排期 |
| [AniList](https://anilist.co) | 每集的精确 UTC 时刻、类型标签、海报 |

缺中文名的会用 Bing 兜底机翻，界面上明确标成 **「临时机翻」**；官方译名一到，
点「更新数据」会**自动替换**（数据库里 `title_cn_source` 从 `machine` 变回 `official`）。
不该翻的**不翻**：已有官方中文名、原名本身是中文、或原名是纯拉丁字母的（`dreamland` 直接可读）。

---

## 同一部番不会变成两条记录

这是实测踩得最深的一个坑，值得单独说 —— 因为它**不会报错**，只会让同一部番在界面上出现两次，
而且两次的首播时间还对不上。

**为什么会发生**：跨源聚类（`src/core/merge.ts`）只在**单次抓取的内存里**做，写完就忘。
而写库的主键（`subject.key`）是**按"这次哪个源成功了"算出来的**：
三源齐全时是 `bgm:<id>`，某次只有 yuc 成功（另一个源超时、或缓存里没这部番）时就退化成
`title:<归一化名>`。于是同一次番剧先以 `title:` 形态落库，下一次又以 `bgm:` 形态落一条新的，
**旧的永远不会被删**。

**现在的做法**（`src/server/db.ts` 的 `resolveSubjectIdentity()`）：
落库**之前**必须走一次统一的"找已有番"判定，顺序不可颠倒：

1. **外部 ID**（`bgm_id` / `anilist_id` / `mal_id`）命中 → 复用那一行
2. 未命中 → **退到归一化标题**匹配（大小写/全半角/标点/季数后缀都归一化后再比）
3. 仍未命中 → 才新建

第 2 步是必须的：实测库里**有三成条目一个外部 ID 都没有**，只按 ID 查必然漏。
而且**按 ID 命中之后仍然要按标题扫一遍** —— 否则同一部番的 `title:` 旧行永远碰不到它。

**顺带的两条纪律**：

- 认定是同一条之后，带外部 ID 的那一行活下来（稳定身份），无 ID 的脏行被**吸收**：
  `my_anime` / `schedule_override` / `change_log` 的引用在**同一个事务**里改指新行，再删旧行。
  闸门不通过（比如两条都挂着你的追番）就**不删也不动引用**，只报告。
- 一次"只有 yuc 成功"的同步**不会**把这条番的分集判成"消失了"：
  删除分支要求**库里那条时刻的数据源这次仍然在场**。修之前这里有 2772 条假报警（实测 100% 是假的）。

**每次同步都会留账**（`sync_run` 表）：哪次运行、抓了哪些季度、每个源的成败条数、
身份判定吸收了几条。命令行看：

```bash
node src/server/cli.ts runs --limit=10
```

---

## 深夜番：这个项目最容易做错的一件事

日本电视台把深夜番写成 **「日曜 24:30」** —— 放送日历上是**周日**，真实钟点却是**周一 00:30**。
同一集，两种口径落在不同的一天，甚至不同的一周。多数日历工具在这里会错位一天。

本项目的做法：

1. 数据库里**同时**保存两个星期归属，绝不混用
2. 日历提供两种分组口径，由你切换：
   - `按真实钟点` —— 周一 00:30 落在周一
   - `按日本放送日历` —— 同一集落在周日
3. 所有时间统一以 **ISO 8601 UTC** 存储，展示时才转换

命令行可以直接看到差别（同一集、同一周、结果不同）：

```bash
$ node src/server/cli.ts week --rule=clock
本周更新  2026-09-28 ~ 2026-10-04（JST）  归属口径：真实钟点
这一周没有你追的番更新。

$ node src/server/cli.ts week --rule=broadcast-calendar
本周更新  2026-09-28 ~ 2026-10-04（JST）  归属口径：日本放送日历
周日 2026-10-04
  黑暗召唤师在地下恋爱中   第 1 话   周一 01:20 (JST)   2 天 8 小时后
```

第 1 话的真实钟点是周一 01:20，所以按钟点算它属于**下一周**；而日本排期表把它记在周日深夜，
所以按放送日历算属于**本周**。

---

## 补番库是显式建模的

「番没看完就到下一季了」这件事不靠你自己记：

- **自动归档**：季度同步时，`已播完 + 看了至少 1 集 + 没看完` 的追番自动移入补番库
  - 一集都没看的**不动** —— 那是「想看」，自动搬运会很烦人
  - 总集数未知的**不动** —— 不能靠猜迁移
- **手动加任意老番**：`node src/server/cli.ts add "番名" --backlog`，不限季度
- **归档可见**：每次移动都会当场告诉你是哪几部

  > 沉默的自动搬运 = 「我的记录消失了」的观感，所以这里刻意做成显式的。

---

## 常用命令

```bash
node src/server/cli.ts                    # 不带参数会打印全部命令
node src/server/cli.ts update              # 一键更新：抓当季 + 回填历史 + 机翻 + 报告
node src/server/cli.ts update --no-translate
node src/server/cli.ts update --seasons=2026-10,2024-10   # 自己挑季度（可含库里没有的）
node src/server/cli.ts sync --backfill=4   # 增量回填最近 4 季
node src/server/cli.ts season              # 只看当季清单（不落库）
node src/server/cli.ts search "药屋"        # 本地优先，中文名与别名都能命中
node src/server/cli.ts add "番名" --backlog # 加一部老番进补番库（界面里没有加番入口）
node src/server/cli.ts list                # 我的追番 / 补番库
node src/server/cli.ts changes             # 延期 / 改档
node src/server/cli.ts runs                # 最近几次同步的运行记录（各源成败、身份判定吸收几条）
node src/server/cli.ts backups             # 看备份与库里的季度
node src/server/cli.ts stats
```

### 自检

```bash
pnpm exec tsc --noEmit        # 类型检查，0 错误
node scripts/verify.ts         # 127 项离线自检（不需要装包、不需要联网）
node scripts/verify-api.ts     # 28 项接口自检（需要服务已启动）
pnpm ui:smoke                   # 前端交互冒烟：筛选/排序按钮到底有没有反应
```

`scripts/verify-api.ts` 会打**真实源站与翻译接口**，也会往库里写测试数据 ——
跑之前建议先备份 `data/anime.db`。

---

## HTTP 接口

服务只监听 `127.0.0.1`，不对外暴露（单人本地工具，不需要鉴权）。

```
GET  /api/health          GET  /api/overview       GET  /api/week
GET  /api/my              POST /api/my             PATCH|DELETE /api/my/:key
GET  /api/subject/:key    POST /api/override       GET  /api/search
POST /api/search/import   POST /api/sync           POST /api/update
POST /api/translate       GET  /api/changes        POST /api/changes/ack
GET  /api/ics             GET  /api/export         GET  /api/runs
```

`/api/update` 支持自选季度（与 CLI 的 `--seasons=` 同一套语义）：

```
/api/update?seasons=2026-10,2024-10&translate=0
```

`/api/runs` 返回最近几次同步的运行记录（哪次运行、抓了哪几季、每个源成了几条、身份判定吸收了几条）。

`/api/overview` 支持多季合并与排序，例如：

```
/api/overview?season=2026-10,2026-07&sort=firstAir
```

`sort` 可选 `firstAir` / `firstAirDesc` / `weekday` / `titleCn` / `totalEps`。

---

## 数据安全

追番列表、进度、手动修正**不可重建**，所以：

- **自动备份**：启动服务时、以及每次写库（同步 / 更新）**之前**，备份到 `data/backups/`，只留最近 20 份
  - ⚠️ 本项目用 WAL 日志模式，**只拷 `anime.db` 会丢数据**。实测过：只拷主文件时
    `subject` 有 126 行而 `my_anime` **是 0 行** —— 追番列表整条丢。
    所以备份会先 `wal_checkpoint(TRUNCATE)`，再把 `-wal` / `-shm` 一起拷过去
- **导出**：界面「导出我的数据」→ `GET /api/export`，下载 JSON
  （含追番列表与进度、手动修正、变更历史；抓来的番剧数据可重抓，故不在此列）
- **历史季度从不删除**：同步只 upsert 当季，季度下拉框随时能切回上一季
- **你的数据只会被"搬家"，不会被删**：同一部番的两条记录合并时，
  追番分类、进度、手动修正都会**在同一个事务里改指到保留的那条**，合并前后条数不变。
  只有一种情况会停下不动：**两条都挂着你的追番**（该保留哪条、进度怎么并是人的判断，
  代码不猜，只报告）。注意这里合并的是**抓来的番剧数据**，你的列表、进度、手动修正永不删。

---

## 目录结构

```
anime-tracker/
├─ src/
│  ├─ core/          零依赖纯逻辑
│  │                 time(时间/深夜番归属) · calendar(日历分组) · backlog(补番规则)
│  │                 mt(该不该机翻) · merge(多源融合+字段优先级) · types
│  ├─ providers/     数据源接入
│  │                 http(代理/限速/超时) · snapshot(原始响应落盘) · validate(zod)
│  │                 bangumi-data · yuc · anilist · mt(Bing机翻) · provider(统一接口)
│  └─ server/        db(node:sqlite，含写库前的身份判定) · schema.sql
│                    sync(抓取+落库+回填+一键更新) · changes(延期检测)
│                    server.ts(HTTP) · ics · cli.ts
├─ web/              界面：index.html · styles.css · app.js（原生 ES 模块，零构建）
├─ desktop/          Windows 启动器与快捷方式（脚本必须纯 ASCII）
├─ scripts/          verify(127) · verify-api(28) · ui-smoke · preview-ui
│                    probe-sources(数据源探测) · diagnose-network
├─ data/             anime.db + backups/ + cache/（已 gitignore，不入库）
└─ docs/             数据源实测 · 决策记录(ADR) · 设计方案 · 交接文档
```

---

## 技术选型

| 选择 | 理由 |
|---|---|
| Node 24 **原生跑 `.ts`** | 零构建步骤，`node src/server/cli.ts` 直接跑，改完即生效 |
| `node:sqlite` | 无原生模块编译问题（Windows 上装 node-gyp 是常见的坑），且零依赖 |
| `undici` 而非全局 fetch | 全局 fetch 不读 `HTTPS_PROXY`，而 Bangumi 必须走代理 |
| 只监听 `127.0.0.1` | 单人本地工具，不需要鉴权，也不该对外暴露 |
| 原始响应落盘 | 可离线重放解析、可对比出「延期/改档」、调试时不反复打源站 |
| 机翻用 Bing | 实测 Google 系全部不可达、微软官方接口要订阅密钥；Bing 可用且质量最好 |

**为什么不用框架**：核心逻辑是时间计算与字段融合，框架帮不上忙；
不引框架就不需要构建步骤、也不需要几百个依赖。界面用原生 ES 模块 + 一个 `app.js` 就够。

---

## 已知限制 / 路线图

- ✅ 已实现：当季抓取、周视图、全季总览（筛选/排序/多季）、追番与补番库、变更检测、
  历史季度保留与回填、**自选季度更新范围**、临时机翻、`.ics` 导出、数据备份与导出、
  Windows 桌面启动器、**同一部番的身份判定（不再产生重复记录）+ 每次同步的运行记录**
- 🚧 **Bilibili PGC** —— 把「国内几点能看」落到每一集（接口已验证可用，未接入）
- 🚧 **桌面通知** —— 更新前提醒（`.ics` 已覆盖手机端）
- 🚧 **补番计划的界面入口** —— 数据层已支持「每周几看 / 每天几集」
- ⬜ 明确不做：在线播放 / 弹幕 / 社交 / 云同步账号 / 独立手机 App

### 关于"同一部作品被两个源各记一份"

身份判定已经能处理**绝大多数**情况（判据是跨源 ID + 归一化标题 + 季度）。
但库里**故意保留**了一小批"两张卡各自带着不同的外部 ID、且分集数/季度对不上"的记录 ——
它们多半是**同一部作品的不同季**（第 1 季 vs 第 2 季、本季 vs 下一季），
草率合并会把两部不同的番并成一条。这类只能靠人工判断，所以代码里的策略是：
**没有把握就不动，只报告**。

---

## 网络问题排查

抓不到数据时**先跑诊断，不要用 curl 下结论**（PowerShell 与 curl 走 schannel，
在本机可能全部失败而 Node 正常）：

```bash
node scripts/diagnose-network.ts
```

已知的坑：

1. **`api.bgm.tv` 被 DNS 污染** → 需要代理：`$env:HTTPS_PROXY = "http://127.0.0.1:7890"`
2. **`yuc.wiki` 的 HTTPS 证书已过期** → 只能走 `http://`
3. **`diagnose-network.ts` 说源站不可达 ≠ 真的不可达** → 用 Node 复现

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/sources.md](docs/sources.md) | 三个数据源的实测结论（字段、可用性、坑） |
| [docs/决策记录.md](docs/决策记录.md) | ADR：为什么这么做 |
| [docs/方案报告-v1.md](docs/方案报告-v1.md) | 最初的设计方案 |
| [docs/交接说明-第四轮.md](docs/交接说明-第四轮.md) | 自包含的开发交接文档（硬约束、坑、待办） |

---

## 许可

尚未指定 License。如果你想用这份代码，欢迎先提 Issue 说一声。
