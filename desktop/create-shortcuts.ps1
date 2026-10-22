# Create the desktop shortcut for the anime calendar.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File desktop\create-shortcuts.ps1
#
# You can also just double-click the .cmd file in this folder.
#
# Creates ONE shortcut: the silent launcher (start-anime-calendar.vbs) with the
# project icon (desktop\app-icon.ico). Older versions created three shortcuts
# (normal / silent / stop); this script deletes those and recreates the plain
# name pointing at the silent launcher. Stop / restart now live in the web UI
# ("More" menu) so they can shut down gracefully instead of taskkill /F.
#
# IMPORTANT: this file must stay 100% ASCII -- including comments.
#
# Why: Windows PowerShell 5.1 reads .ps1 files with the system ANSI code page
# (GBK on a Chinese Windows) unless the file starts with a UTF-8 BOM. Without a BOM,
# Chinese text turns into mojibake, and worse: when a comment line ends with a byte
# that looks like a GBK lead byte, the decoder swallows the following line break and
# the NEXT LINE ENDS UP INSIDE THE COMMENT. That silently deleted an assignment here
# and produced "Cannot bind argument ... because it is an empty string".
#
# A BOM would also fix it, but it is silently dropped by editors and by any tool that
# rewrites the file as plain UTF-8, so the breakage comes back. ASCII cannot break.
# The Chinese shortcut names are therefore assembled from code points.
#
# Please do not "simplify" the code point lists back into Chinese literals.

$ErrorActionPreference = 'Stop'

function ConvertFrom-CodePoints {
  param([Parameter(Mandatory)][int[]]$CodePoints)
  return (-join ($CodePoints | ForEach-Object { [char]$_ }))
}

# Shortcut names (Chinese, see the code point comments):
#   0x65B0 xin  0x756A fan  0x8FFD zhui  0x756A fan  0x65E5 ri  0x5386 li
$startLabel = ConvertFrom-CodePoints 0x65B0, 0x756A, 0x8FFD, 0x756A, 0x65E5, 0x5386
#   0x505C ting 0x6B62 zhi 0x65B0 xin 0x756A fan 0x65E5 ri 0x5386 li
$stopLabel = ConvertFrom-CodePoints 0x505C, 0x6B62, 0x65B0, 0x756A, 0x65E5, 0x5386
# Debug shortcut: <startLabel> + "(" + 0x8C03 diao 0x8BD5 shi + ")"
$debugSuffix = ConvertFrom-CodePoints 0x8C03, 0x8BD5
$debugLabel = "$startLabel$debugSuffix"
# Silent option: <startLabel> + "(" + 0x9759 jing 0x9ED8 mo + ")"
#   0x9759 jing  0x9ED8 mo
$silentSuffix = ConvertFrom-CodePoints 0x9759, 0x9ED8
$silentLabel = "$startLabel$silentSuffix"

# 0x6253 da 0x5F00 kai 0x65B0 xin 0x756A fan 0x8FFD zhui 0x756A fan 0x65E5 ri 0x5386 li
$startDescription = ConvertFrom-CodePoints 0x6253, 0x5F00, 0x65B0, 0x756A, 0x8FFD, 0x756A, 0x65E5, 0x5386
# 0x505C ting 0x6B62 zhi 0x65B0 xin 0x756A fan 0x8FFD zhui 0x756A fan 0x65E5 ri 0x5386 li
# 0x7684 de 0x672C ben 0x5730 di 0x670D fu 0x52A1 wu
$stopDescription = ConvertFrom-CodePoints 0x505C, 0x6B62, 0x65B0, 0x756A, 0x8FFD, 0x756A, 0x65E5, 0x5386, 0x7684, 0x672C, 0x5730, 0x670D, 0x52A1
# Debug: 0x8C03 diao 0x8BD5 shi 0x5165 ru 0x53E3 kou <space> 0x53EF ke 0x89C1 jian 0x62A5 bao 0x9519 cuo
$debugDescription = ConvertFrom-CodePoints 0x8C03, 0x8BD5, 0x5165, 0x53E3, 0x20, 0x53EF, 0x89C1, 0x62A5, 0x9519
# Silent: 0x9759 jing 0x9ED8 mo 0x542F qi 0x52A8 dong <space> 0x4E0D bu 0x5F39 dan 0x7A97 chuang 0x53E3 kou
$silentDescription = ConvertFrom-CodePoints 0x9759, 0x9ED8, 0x542F, 0x52A8, 0x20, 0x4E0D, 0x5F39, 0x7A97, 0x53E3

$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
# The launcher scripts use ASCII file names on purpose, so this script needs no
# non-ASCII file names either.
$startScript = Join-Path $root 'desktop\start-anime-calendar.vbs'
$debugScript = Join-Path $root 'desktop\start-anime-calendar-debug.cmd'
$stopScript = Join-Path $root 'desktop\stop-anime-calendar.cmd'

if (-not (Test-Path $startScript)) {
  throw "Launcher not found: $startScript"
}
if (-not (Test-Path $debugScript)) {
  throw "Debug launcher not found: $debugScript"
}

$shell = New-Object -ComObject WScript.Shell
$script:failures = @()

# ---------------------------------------------------------------------------
# Step 1: prove the desktop folder is writable BEFORE touching anything.
#
# This is not paranoia: the previous version of this script created the shortcuts
# one by one and, on a desktop that cannot be written to, would fail only after
# some shortcuts had already been replaced (or deleted). A verification step that
# can destroy the thing it verifies is worse than no step at all.
# ---------------------------------------------------------------------------
Write-Host 'Checking that the desktop folder is writable ...'

if (-not (Test-Path $desktop)) {
  Write-Host "  FAILED  : desktop folder does not exist: $desktop"
  Write-Host ''
  Write-Host 'Shortcuts were NOT created and nothing was deleted.'
  Write-Host 'Create them by hand instead:'
  Write-Host "  1) right-click the desktop -> New -> Shortcut"
  Write-Host "  2) enter: $startScript"
  Write-Host "     or, if that one does nothing: $debugScript"
  exit 1
}

$probe = Join-Path $desktop ("anime-tracker-probe-{0}.tmp" -f ([guid]::NewGuid().ToString('N')))
try {
  Set-Content -LiteralPath $probe -Value 'probe' -ErrorAction Stop
  Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
  Write-Host '  OK'
} catch {
  Write-Host "  FAILED  : cannot write to $desktop"
  Write-Host "            $($_.Exception.Message)"
  Write-Host ''
  Write-Host 'Shortcuts were NOT created and nothing was deleted.'
  Write-Host ''
  Write-Host 'Likely causes and what to do:'
  Write-Host '  1) OneDrive is syncing or the folder is "Files On-Demand" only:'
  Write-Host '     open the desktop folder in Explorer once so it is materialised.'
  Write-Host '  2) Security software / group policy blocks writes to the desktop:'
  Write-Host '     run this script again as administrator.'
  Write-Host '  3) The desktop is read-only or redirected:'
  Write-Host '     create the shortcut by hand -> right-click the desktop -> New -> Shortcut ->'
  Write-Host "       $startScript"
  Write-Host ''
  Write-Host 'The application itself is unaffected: run "pnpm web" in the project folder'
  Write-Host 'and open http://127.0.0.1:8787, or double-click desktop\start-anime-calendar.vbs'
  exit 1
}

function New-Shortcut {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Target,
    [Parameter(Mandatory)][string]$Icon,
    [Parameter(Mandatory)][AllowEmptyString()][string]$Description
  )

  $path = Join-Path $desktop $Name
  try {
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = $Target
    $shortcut.WorkingDirectory = $root
    $shortcut.IconLocation = $Icon
    $shortcut.Description = $Description
    $shortcut.Save()
    Write-Host "  created : $path"
  } catch {
    Write-Host "  FAILED  : $path"
    Write-Host "            $($_.Exception.Message)"
    $script:failures += $path
  }
}

# ---------------------------------------------------------------------------
# Step 2: remove the "downloaded from the Internet" mark from the launcher
# scripts.
#
# Why: a file carrying the Zone.Identifier alternate data stream (Windows calls
# it "Mark of the Web") makes Explorer show an "Open File - Security Warning"
# ("Do you want to open this file?") before running it -- and for .cmd files
# "We can't verify who published this software. Are you sure you want to run it?".
# That looks exactly like the launcher being broken, but it is only Windows
# asking for confirmation. Unblocking the files removes that prompt.
#
# This is a no-op when the files are already clean.
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'Removing the "downloaded from the Internet" mark from the launcher files ...'

$blocked = 0
foreach ($file in @($startScript, $debugScript, $stopScript)) {
  if (-not (Test-Path -LiteralPath $file)) { continue }
  $stream = Get-Item -LiteralPath $file -Stream Zone.Identifier -ErrorAction SilentlyContinue
  if (-not $stream) {
    Write-Host "  clean   : $(Split-Path -Leaf $file)"
    continue
  }
  try {
    Unblock-File -LiteralPath $file -ErrorAction Stop
    Write-Host "  unblocked: $(Split-Path -Leaf $file)"
    $blocked += 1
  } catch {
    Write-Host "  FAILED  : $(Split-Path -Leaf $file)"
    Write-Host "            $($_.Exception.Message)"
    Write-Host "            Right-click the file -> Properties -> tick Unblock."
  }
}
if ($blocked -eq 0) {
  Write-Host '  (nothing needed unblocking)'
}

Write-Host ''
Write-Host 'Creating the desktop shortcut ...'
# ONE shortcut only (the silent launcher):
#   - the previous "normal" one opened a visible console; it is the same launcher
#     with a console attached, so it added nothing but a second icon
#   - stopping / restarting the server now lives in the web UI ("More" menu),
#     which also checkpoints the SQLite WAL instead of a hard taskkill
#   - the .cmd / .vbs files stay in desktop\ for troubleshooting; they just do
#     not get their own desktop icons any more
$iconSource = Join-Path $root 'desktop\app-icon.ico'
if (-not (Test-Path -LiteralPath $iconSource)) {
  throw "Icon not found: $iconSource"
}

# The shortcut points at a COPY of the icon under %LOCALAPPDATA%, not at the
# file inside the project folder, on purpose:
#   - the project folder can end up with an ACL / integrity label the Explorer
#     icon extractor is not allowed to read (containers, sandboxes, some
#     policy-managed folders). Windows then silently draws the generic blank
#     document icon instead of the real one -- the shortcut itself looks fine,
#     only the picture is wrong, which is confusing to debug
#   - %LOCALAPPDATA% always has the normal per-user rights, so the shell can
#     read it no matter where the project lives
# The copy is refreshed on every run, so editing app-icon.ico + re-running this
# script is enough to pick up a new icon.
$iconDir = Join-Path $env:LOCALAPPDATA 'anime-tracker'
New-Item -ItemType Directory -Path $iconDir -Force | Out-Null
$iconPath = Join-Path $iconDir 'app-icon.ico'
Copy-Item -LiteralPath $iconSource -Destination $iconPath -Force
Unblock-File -LiteralPath $iconPath -ErrorAction SilentlyContinue

# Create / overwrite the single plain-name shortcut FIRST, then drop the two
# extra icons from older versions. Doing it in that order means a failure can
# never leave the desktop with no shortcut at all.
New-Shortcut -Name "$startLabel.lnk" -Target $startScript -Icon "$iconPath,0" -Description $silentDescription

# Explorer caches icons per file path. A shortcut that was just re-created can
# keep showing the icon of the PREVIOUS version until the cache is flushed, so
# ask the shell to drop it now instead of telling the user to log off and on.
try {
  Add-Type -Namespace Win32 -Name Shell -MemberDefinition @'
[DllImport("shell32.dll")]
public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
'@
  # SHCNE_ASSOCCHANGED flushes the icon cache; SHCNF_FLUSH waits for it.
  [Win32.Shell]::SHChangeNotify(0x08000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)
  Write-Host '  icon cache: refreshed'
} catch {
  Write-Host '  icon cache: could not refresh (harmless, Explorer will catch up later)'
}

foreach ($oldName in @("$silentLabel.lnk", "$stopLabel.lnk")) {
  $oldPath = Join-Path $desktop $oldName
  if (-not (Test-Path -LiteralPath $oldPath)) { continue }
  try {
    Remove-Item -LiteralPath $oldPath -Force -ErrorAction Stop
    Write-Host "  removed : $oldName"
  } catch {
    Write-Host "  WARN    : could not remove $oldName"
    Write-Host "            $($_.Exception.Message)"
  }
}

Write-Host ''
if ($script:failures.Count -eq 0) {
  Write-Host 'Done. Double-click the shortcut on your desktop to start.'
  Write-Host ''
  Write-Host 'What changed:'
  Write-Host '  - exactly ONE shortcut is created: silent start (no console window),'
  Write-Host '    every step logged to <project>\data\launcher.log'
  Write-Host '  - the old "(silent)" and "stop" extras are removed automatically'
  Write-Host '    (the plain "New anime calendar" name is reused, no duplicate icons)'
  Write-Host '  - stop / restart the server from the web page: More -> Stop service /'
  Write-Host '    Restart service (a graceful shutdown, not taskkill /F)'
  Write-Host '  - if the browser ever refuses to open, run desktop\start-anime-calendar-debug.cmd'
  Write-Host '    by hand: same launcher, visible console, real error text'
  Write-Host ''
  Write-Host 'The shortcut starts the browser directly (it does not rely on the Windows'
  Write-Host 'http:// URL association), so it keeps working when the default browser is'
  Write-Host 'uninstalled or moved.'
  Write-Host "Server: http://127.0.0.1:8787    Database: $root\data\anime.db"
  Write-Host "Log:    $root\data\launcher.log"
  Write-Host "Icon:   $iconPath  (a copy, so Explorer can always read it)"
} else {
  Write-Host 'Some shortcuts could not be written.'
  Write-Host "Desktop path: $desktop"
  Write-Host ''
  Write-Host 'Existing shortcuts were left alone; only the step that failed is affected.'
  Write-Host ''
  Write-Host 'Workarounds:'
  Write-Host '  1) Run this script again as administrator.'
  Write-Host "  2) Create a shortcut manually pointing at: $debugScript"
  Write-Host "     (or, for the silent one: $startScript)"
  Write-Host '  3) Or run "pnpm web" in the project folder and open http://127.0.0.1:8787'
}
