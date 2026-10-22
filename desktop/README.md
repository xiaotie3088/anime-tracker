# 桌面端启动方式

## ⚠ 第一次使用前：必须先装依赖

**刚 `git clone` 下来的项目，直接双击快捷方式是跑不起来的。** 先在这个项目目录里执行一次：

```bash
pnpm install
```

没有 pnpm 的话，`npm install` 也一样。这一步只需要做一次。

### 为什么

三个数据源客户端与响应校验用了运行时依赖（`zod` / `undici`），而它们**没有**提交进仓库
（`node_modules/` 在 `.gitignore` 里 —— 那是本机环境，本来也不该进版本库）。

不装依赖直接启动，会在控制台看到：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod'
    imported from ...\src\core\types.ts
```

启动器其实会先提醒一句（`[WARN] node_modules is missing ...`），
但控制台一闪而过容易看漏，所以这里单独写清楚。

**装完依赖之后**，本目录的快捷方式就完全正常了 —— 数据库和 `data\` 目录会在首次启动时自动创建。

---

## 用法

1. 双击本目录下的 **`创建桌面快捷方式.cmd`**（只需一次）。
   它只创建一个快捷方式：
   - **新番追番日历** —— 静默启动（无控制台窗口），图标是项目自己的图标
     （`desktop\app-icon.ico`）。旧版留下的「新番追番日历静默」「停止新番日历」图标会被自动删除。
2. 之后每次双击桌面上的「新番追番日历」即可。
3. **停止 / 重启**：在网页右上角「更多 → 停止服务 / 重启服务」。
   停止是优雅关闭（先 checkpoint WAL 再关库），不是 `taskkill /F`；
   服务停掉后页面会显示「服务已停止」，下次双击桌面图标启动。

### 图标为什么复制到 `%LOCALAPPDATA%`

快捷方式的图标**不直接指向项目里的 `desktop\app-icon.ico`**，而是先复制到
`%LOCALAPPDATA%\anime-tracker\app-icon.ico`，快捷方式再指向那份副本。

原因：项目文件夹可能带着「资源管理器读不到」的 ACL / 完整性标签（容器、沙箱、
某些受策略管理的目录都会这样）。这时 Windows 不会报错，只是**悄悄画成一张空白文档图标** ——
快捷方式本身是好的，只有图片不对，属于最难查的那类问题（本项目就踩过：
`IconLocation` 写对了、图标文件用 `SHDefExtractIcon` 也能正常提取，桌面上却一直是白纸）。

`%LOCALAPPDATA%` 是当前用户的普通目录，权限一定正常，所以副本一定能被读出来。
脚本每次运行都会重新复制，所以**换了图标只要重跑一次脚本**。

> 如果桌面上已经是白纸图标、重跑脚本也不变：那是资源管理器的图标缓存。
> 脚本最后会主动调 `SHChangeNotify(SHCNE_ASSOCCHANGED)` 清一次，正常情况下不用再手动处理；
> 实在不刷新再注销一次（或重启资源管理器）。

`start-anime-calendar-debug.cmd` 仍然保留：双击它会在**可见控制台**里启动同一个服务，
出错原因直接打在屏幕上。杀软拦 `.vbs` 或浏览器打不开时，用它排障。

## 为什么快捷方式走 `.vbs`（静默）

现在桌面只留一个图标，默认无窗口。它同样避开了两个坑：

1. **不依赖 http 网址关联** —— 启动器自己找浏览器 exe 并直接打开（见下一节）。
2. **不需要手写停止脚本** —— 停 / 重启在网页里做，顺带把 SQLite WAL 收干净。

代价是出错时屏幕上什么都没有 —— 所以它把每一步写进 `data\launcher.log`，
而排障入口 `start-anime-calendar-debug.cmd` 保留了可见控制台与真实报错。

## 这台机器上真实存在的两个问题（都已在启动器里绕开）

### 1. 打开网址报「找不到应用程序」

系统的 http 默认处理程序指向一个**已经不存在的浏览器**：

```
HKCU\...\UrlAssociations\http\UserChoice   ProgId = QuarkHTM
QuarkHTM\shell\open\command = "D:\Program\Quark\quark.exe" --brand-quark ...
```

`D:\Program\Quark\quark.exe` 已被移走或删除，于是**任何**程序用"打开这个网址"的方式
调浏览器都会弹出「找不到应用程序」—— 浏览器本身没坏，是关联坏了。

启动器的处理方式：**不把网址交给系统去关联，而是直接调用浏览器 exe**，顺序是

1. 你设的默认浏览器（从注册表读出它的 exe，**直接启动**）—— 尊重你的选择，
   但它的 exe 不存在时就自动跳过（夸克现在就是这种状态）
2. Chrome → Edge → Firefox 的常见安装位置

实测日志（`data\launcher.log`）：

```
http UserChoice ProgId = QuarkHTM
default browser exe is missing on disk: D:\Program\Quark\quark.exe
no usable default browser found; falling back to known paths
launched: C:\Program Files\Google\Chrome\Application\chrome.exe
```

> 想彻底修好系统层面，可以：设置 → 应用 → 默认应用 → 把 Google Chrome 设为默认浏览器。
> 不修也不影响本项目使用。

### 2. 双击时先弹「打开文件 - 安全警告」

那是 Windows 的"来自 Internet 的文件"标记（Mark of the Web，存在文件的
`Zone.Identifier` 附加数据流里）。它看起来像启动器坏了，其实只是系统在问"要不要打开"。

`create-shortcuts.ps1` 会**主动解除**这个标记（`Unblock-File`），所以重跑一次
创建快捷方式就不会再弹。手动解除也可以：右键文件 → 属性 → 勾选「解除锁定」。

## 出问题时先看日志

静默启动器（`.vbs`）的每一步都写进 **`data\launcher.log`**（每次启动重写）：
找 node、起服务、探健康、选浏览器、打开结果。

`.cmd` 启动器不需要日志 —— 它把同样的信息直接打在屏幕上。

## 文件说明

| 文件 | 作用 |
|---|---|
| `start-anime-calendar.vbs` | 静默启动器（桌面快捷方式用它）：后台起服务 + 写 `data\launcher.log` |
| `start-anime-calendar-debug.cmd` | 排障入口：前台、可见报错、不依赖 WSH 与网址关联 |
| `stop-anime-calendar.cmd` | 按端口找出服务进程并停止（网页停不了时的后备） |
| `create-shortcuts.ps1` | 创建**一个**快捷方式（静默 + 图标副本，清理旧图标；带桌面写权限预检 + 解除文件封锁 + 清图标缓存） |
| `app-icon.ico` / `app-icon.svg` | 快捷方式图标（多尺寸 ico）与可编辑的 SVG 母版；脚本会把它复制到 `%LOCALAPPDATA%\anime-tracker\` 再给快捷方式用 |
| `创建桌面快捷方式.cmd` | 上面那个脚本的双击入口 |

## 它是怎么找到 node 的

上一版是靠 `cmd /c node.exe` 走 PATH —— 而 PATH 正是最容易出问题的一环。
现在按顺序尝试：

1. `%ProgramFiles%\nodejs\node.exe`
2. `%ProgramFiles(x86)%\nodejs\node.exe`
3. `%LOCALAPPDATA%\Programs\nodejs\node.exe`
4. `%APPDATA%\npm\node.exe`
5. 最后才退回 `where node`（这次降级会记进日志）

全部失败就给出明确指引，而不是静默什么都不做。

> 注：上面是 `start-anime-calendar.vbs`（静默启动器）的完整顺序。
> `start-anime-calendar-debug.cmd` 只试前 3 个位置加 PATH 兜底 —— 两者都够用，
> 因为第 4 个（`%APPDATA%\npm`）是 npm 全局安装的少见位置。

## 为什么不是真正的 exe

用 Electron / Tauri 打包成单文件 exe，需要引入 Rust 或几百 MB 的运行时，还要处理打包与签名，
而换来的唯一好处是「目标机器不用装 Node」。你本机已经有 Node，所以：

- **收益**：双击即用、启动一秒、零构建步骤、改代码立刻生效（不用重新打包）
- **代价**：它不是单文件 exe，依赖本目录里的 Node 环境；换电脑要把整个项目目录一起带过去

如果以后真的需要分发给别人，再考虑 `pnpm exec pkg` 或 Tauri —— 届时核心代码不用改，
因为服务与界面是分离的（`src/server/` + `web/`）。

## ⚠ 所有启动脚本都必须纯 ASCII（含注释）

这不是洁癖，是踩过三次的坑：

- **`.vbs`**：Windows Script Host 按 ANSI 读取，UTF-8 中文会变乱码并直接报语法错误
  （「未结束的字符串常量」）。
- **`.ps1`**：Windows PowerShell 5.1 在没有 BOM 时也按 ANSI 读取。更隐蔽的是，
  当某行**注释**以 UTF-8 中文字符结尾时，最后一个字节会被当成 GBK 前导字节而吞掉换行，
  **导致下一行代码被并进注释里** —— 表现为莫名其妙的「参数为空字符串」。
- **`.cmd`**：cmd.exe 按 OEM 代码页（中文环境是 GBK）解析，中文 `echo` 会被当成命令报错。

所以：这些脚本里给用户看的中文（快捷方式名、弹框提示）全部由 Unicode 码点拼出来
（PS1 用 `[char]`，VBS 用 `ChrW`）。**请不要把它们"简化"回中文字面量。**
界面与文档不受影响，照常用中文。

另外两个 `.cmd` 里的注意点（都踩过）：

- **不要在 `if (...)` 或 `for (...)` 里用 `%ProgramFiles(x86)%`** —— 变量名里的右括号会提前
  结束代码块，报 `\Microsoft\Edge\... was unexpected at this time`。用 `%ProgramW6432%` 代替。
- 想在块内改并立刻读一个变量，要么开 `enabledelayedexpansion` 用 `!VAR!`，
  要么用 `call :label` 的形式（本目录的脚本用的是后者）。

工作目录下的 `创建桌面快捷方式.cmd` 文件名是中文 —— 这是安全的，
因为文件名由 NTFS 以 UTF-16 保存，出问题的只有**文件内容**的编码。
