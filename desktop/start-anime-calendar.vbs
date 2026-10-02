' New Anime Calendar - launcher (hardened, browser-exe based)
'
' What it does:
'   1. Log every step to data\launcher.log, so a silent failure can still be diagnosed.
'   2. Find a working node.exe: probe the standard install locations first, then PATH.
'   3. If the local server is not running, start it in the background (no console window).
'   4. Wait until /api/health actually responds, then open the calendar page.
'   5. If the server is already running, just open the page (no double start).
'
' WHY WE LAUNCH A BROWSER .EXE INSTEAD OF JUST shell.Run(url):
'   On the user's machine the http/https URL association is BROKEN -- it points at a
'   browser that is no longer installed:
'       HKCU\...\UrlAssociations\http\UserChoice  ProgId = QuarkHTM
'       QuarkHTM\shell\open\command = "D:\Program\Quark\quark.exe" ...   (file gone)
'   So every "open this URL" attempt popped up "no application is associated with
'   the specified file" (Chinese: zhao bu dao ying yong cheng xu), even though the
'   server was running fine.
'   Handing the URL straight to a browser exe does not need that association at all,
'   so it also fixes machines where the default browser was uninstalled or moved.
'
' Why the log file: a silent launcher that cannot explain itself is worse than a
' visible console, so every decision and every error is written to data\launcher.log
' (truncated on each run).
'
' Why not Electron / Tauri (a real .exe):
'   That would pull in Rust or a few hundred MB of runtime plus packaging and signing,
'   just to avoid needing Node installed. Node is already here, so a script + a desktop
'   shortcut gives you double-click-to-run, one second startup, and zero build steps.
'   The tradeoff, stated plainly: this is not a single-file exe, it uses the Node
'   environment inside this project folder.
'
' IMPORTANT: keep this file ASCII-only.
'   Windows Script Host reads .vbs as ANSI, not UTF-8. Non-ASCII characters here get
'   decoded as garbage and can break the parser (a lesson learned the hard way, twice).
'   Chinese text for the user-facing message boxes is therefore built from Unicode
'   code points with ChrW(), never written literally.
'
' If this launcher ever fails again: use "start-anime-calendar-debug.cmd" instead.
' It runs in a visible console and shows the real error text.

Option Explicit

Dim fso, shell, projectRoot, logPath, url
Dim nodeExe, nodeTried, serverStarted, ready, attempt
Dim q, opened, browserUsed

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' This script lives in <project>\desktop\, so two levels up is the project root
projectRoot = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
url = "http://127.0.0.1:8787"
q = Chr(34)
browserUsed = ""

Log "=== launcher start ==="
Log "projectRoot = " & projectRoot
Log "script      = " & WScript.ScriptFullName

' ---------------------------------------------------------------------------
' 1) Make sure the project actually looks like this project
' ---------------------------------------------------------------------------

If Not fso.FileExists(projectRoot & "\src\server\server.ts") Then
  Log "ERROR: src\server\server.ts not found under " & projectRoot
  Fail MsgText("errNoServerTs") & vbCrLf & vbCrLf & projectRoot
End If

If Not fso.FolderExists(projectRoot & "\node_modules") Then
  ' Not fatal: the project can run without any installed package (that is a design goal),
  ' but it is the most common reason a fresh copy does not start. Log it and continue.
  Log "WARN: node_modules is missing; 'pnpm install' has probably not been run"
End If

' ---------------------------------------------------------------------------
' 2) Start the server if it is not already up
' ---------------------------------------------------------------------------

serverStarted = False
If ServerReady(url) Then
  Log "server already responding on " & url & " - not starting a second one"
Else
  nodeExe = FindNode()
  If nodeExe = "" Then
    Log "ERROR: no usable node.exe found"
    Fail MsgText("errNoNode") & vbCrLf & vbCrLf & nodeTried
  End If
  Log "using node: " & nodeExe

  ' Start hidden (0), do not wait (False). Quote the path: "Program Files" has a space.
  shell.CurrentDirectory = projectRoot
  On Error Resume Next
  shell.Run q & nodeExe & q & " " & q & projectRoot & "\src\server\server.ts" & q, 0, False
  If Err.Number <> 0 Then
    Log "ERROR: shell.Run failed: " & Err.Number & " " & Err.Description
    Err.Clear
    On Error GoTo 0
    Fail MsgText("errSpawn") & vbCrLf & vbCrLf & nodeExe
  End If
  On Error GoTo 0
  serverStarted = True
  Log "node started in background"

  ' Wait for /api/health (up to 30 seconds)
  ready = False
  For attempt = 1 To 120
    WScript.Sleep 250
    If ServerReady(url) Then
      ready = True
      Exit For
    End If
  Next

  If Not ready Then
    Log "ERROR: server did not answer /api/health within 30s"
    Fail MsgText("errTimeout")
  End If
  Log "server is up after " & attempt & " polls"
End If

' ---------------------------------------------------------------------------
' 3) Open the page in a real browser executable.
'
'    This is the fix for the broken http association described in the header.
'    Candidates are tried in order and the first existing one wins; the URL is
'    passed as an argument, which every Chromium/Firefox build accepts.
' ---------------------------------------------------------------------------

opened = OpenInBrowserExe(url)
Log "browser exe launch result: " & CStr(opened) & " (" & browserUsed & ")"

' ---------------------------------------------------------------------------
' 4) Fallback: let the shell association try (works on healthy machines)
' ---------------------------------------------------------------------------

If Not opened Then
  Log "no browser exe worked; falling back to the shell URL association"
  On Error Resume Next
  shell.Run url, 1, False
  If Err.Number = 0 Then opened = True Else Err.Clear
  On Error GoTo 0
End If

' ---------------------------------------------------------------------------
' 5) Last resort: tell the user the address instead of failing silently
' ---------------------------------------------------------------------------

If Not opened Then
  Log "ERROR: could not open any browser"
  MsgBox MsgText("errNoBrowser") & vbCrLf & vbCrLf & url, 48, "Anime Calendar"
End If

Log "=== launcher done ==="
WScript.Quit 0

' ---------------------------------------------------------------------------
' Launch a browser executable with the calendar URL.
'
' Returns True if a browser was started. Sets browserUsed for the log.
'
' Order of preference:
'   1) the browser the user actually chose as default, read from
'      HKCU\...\UrlAssociations\http\UserChoice and launched BY ITS EXE --
'      this respects the user's choice while still not depending on the
'      (possibly broken) URL association itself;
'   2) a list of well-known install paths (Chrome, Edge, Firefox).
' ---------------------------------------------------------------------------

Function OpenInBrowserExe(target)
  Dim preferred, index, exePath, candidates, candidate

  OpenInBrowserExe = False
  browserUsed = ""

  ' 1) the user's default browser, launched directly
  preferred = PreferredBrowserExe()
  If preferred <> "" Then
    Log "default browser resolves to: " & preferred
    If LaunchBrowser(preferred, target) Then
      OpenInBrowserExe = True
      browserUsed = preferred
      Exit Function
    End If
    Log "default browser could not be started; falling back to known paths"
  Else
    Log "no usable default browser found; falling back to known paths"
  End If

  ' 2) well-known install paths
  candidates = Array( _
    shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe", _
    shell.ExpandEnvironmentStrings("%ProgramW6432%") & "\Google\Chrome\Application\chrome.exe", _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Google\Chrome\Application\chrome.exe", _
    shell.ExpandEnvironmentStrings("%ProgramW6432%") & "\Microsoft\Edge\Application\msedge.exe", _
    shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe", _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Microsoft\Edge\Application\msedge.exe", _
    shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Mozilla Firefox\firefox.exe", _
    shell.ExpandEnvironmentStrings("%ProgramW6432%") & "\Mozilla Firefox\firefox.exe" _
  )

  For index = 0 To UBound(candidates)
    candidate = candidates(index)
    ' InStr("%") > 0 means an environment variable we could not expand -> skip
    If InStr(candidate, "%") = 0 Then
      If fso.FileExists(candidate) Then
        Log "trying known browser path: " & candidate
        If LaunchBrowser(candidate, target) Then
          OpenInBrowserExe = True
          browserUsed = candidate
          Exit Function
        End If
      End If
    End If
  Next

  browserUsed = "(none found)"
End Function

' Start one browser exe with the URL. Returns True when the process was started.
Function LaunchBrowser(exePath, target)
  LaunchBrowser = False
  On Error Resume Next
  ' 1 = normal window, False = do not wait for the browser to exit
  shell.Run Chr(34) & exePath & Chr(34) & " " & Chr(34) & target & Chr(34), 1, False
  If Err.Number = 0 Then
    LaunchBrowser = True
    Log "launched: " & exePath
  Else
    Log "failed to launch " & exePath & ": " & Err.Number & " " & Err.Description
  End If
  Err.Clear
  On Error GoTo 0
End Function

' ---------------------------------------------------------------------------
' The executable of the user's default browser, or "" if we cannot resolve it.
'
' This is exactly what makes the difference on this machine: the default is
' registered as QuarkHTM but its exe is gone, so we return "" and step down to
' Chrome/Edge instead of popping up "no application is associated".
' ---------------------------------------------------------------------------

Function PreferredBrowserExe()
  Dim progId, commandLine, exePath

  PreferredBrowserExe = ""
  progId = RegReadString("HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice", "ProgId")
  If progId = "" Then Exit Function
  Log "http UserChoice ProgId = " & progId

  commandLine = RegReadDefault("HKCU\Software\Classes\" & progId & "\shell\open\command")
  If commandLine = "" Then commandLine = RegReadDefault("HKLM\Software\Classes\" & progId & "\shell\open\command")
  If commandLine = "" Then Exit Function

  exePath = ExeFromCommandLine(commandLine)
  If exePath = "" Then Exit Function
  If Not fso.FileExists(exePath) Then
    Log "default browser exe is missing on disk: " & exePath
    Exit Function
  End If

  PreferredBrowserExe = exePath
End Function

' ---------------------------------------------------------------------------
' Registry readers.
'
' NOTE: WScript.Shell.RegRead maps a trailing backslash to the key's DEFAULT
' value. Appending Chr(0) would ask for a value literally named "\0", which never
' exists -- and because these calls are wrapped in On Error Resume Next it failed
' silently.
' ---------------------------------------------------------------------------

Function RegReadDefault(regPath)
  Dim value
  RegReadDefault = ""
  On Error Resume Next
  value = shell.RegRead(regPath & "\")
  If Err.Number = 0 Then
    If VarType(value) = vbString Then RegReadDefault = Trim(value)
  End If
  Err.Clear
  On Error GoTo 0
End Function

Function RegReadString(regPath, valueName)
  Dim value
  RegReadString = ""
  On Error Resume Next
  value = shell.RegRead(regPath & "\" & valueName)
  If Err.Number = 0 Then
    If VarType(value) = vbString Then RegReadString = Trim(value)
  End If
  Err.Clear
  On Error GoTo 0
End Function

' Pull the executable path out of a browser launch command line.
' Handles:  "C:\...\chrome.exe"          (quoted, no arguments)
'           "C:\...\chrome.exe" --flag    (quoted, with arguments)
'           C:\...\iexplore.exe           (unquoted)
Function ExeFromCommandLine(commandLine)
  Dim text, closing, firstSpace

  ExeFromCommandLine = ""
  text = Trim(commandLine)
  If text = "" Then Exit Function

  If Left(text, 1) = Chr(34) Then
    closing = InStr(2, text, Chr(34))
    If closing > 2 Then ExeFromCommandLine = Mid(text, 2, closing - 2)
    Exit Function
  End If

  firstSpace = InStr(text, " ")
  If firstSpace > 0 Then
    ExeFromCommandLine = Left(text, firstSpace - 1)
  Else
    ExeFromCommandLine = text
  End If
End Function

' ---------------------------------------------------------------------------
' Error exit: log, then show a message the user can act on.
' ---------------------------------------------------------------------------

Sub Fail(message)
  Log "FAIL: " & Replace(message, vbCrLf, " | ")
  MsgBox message & vbCrLf & vbCrLf & MsgText("logHint") & vbCrLf & logPath, 16, "Anime Calendar"
  WScript.Quit 1
End Sub

' ---------------------------------------------------------------------------
' Diagnostic log. Deliberately forgiving: logging must never be the reason the
' launcher fails, so every filesystem error here is ignored.
' ---------------------------------------------------------------------------

Sub Log(message)
  Dim stream, stamp
  On Error Resume Next

  If logPath = "" Then
    logPath = projectRoot & "\data\launcher.log"
    If Not fso.FolderExists(projectRoot & "\data") Then fso.CreateFolder projectRoot & "\data"
  End If
  If logPath = "" Then Exit Sub

  stamp = Now
  Set stream = fso.OpenTextFile(logPath, 8, True)
  If Err.Number = 0 Then
    stream.WriteLine "[" & stamp & "] " & message
    stream.Close
  End If
  Err.Clear
  On Error GoTo 0
End Sub

' ---------------------------------------------------------------------------
' Find a usable node.exe. Order matters: the standard install locations are tried
' before PATH, because the original launcher relied on "cmd /c node.exe" and that
' is exactly the step that failed silently on the user's machine.
' ---------------------------------------------------------------------------

Function FindNode()
  Dim candidates, candidate, index, resolved

  candidates = Array( _
    shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe", _
    shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\nodejs\node.exe", _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs\node.exe", _
    shell.ExpandEnvironmentStrings("%APPDATA%") & "\npm\node.exe" _
  )

  nodeTried = ""
  For index = 0 To UBound(candidates)
    candidate = candidates(index)
    nodeTried = nodeTried & vbCrLf & "  " & candidate
    If InStr(candidate, "%") = 0 Then
      If fso.FileExists(candidate) Then
        FindNode = candidate
        Log "found node at " & candidate
        Exit Function
      End If
    End If
  Next

  ' Last resort: ask the shell where node is (this is what used to fail, so it is
  ' tried last and its failure is logged explicitly).
  Log "no node.exe in the standard locations; falling back to PATH lookup"
  nodeTried = nodeTried & vbCrLf & "  (PATH lookup via 'where node')"
  resolved = WhereNode()
  If resolved <> "" Then
    FindNode = resolved
    Log "found node on PATH: " & resolved
    Exit Function
  End If

  Log "PATH lookup also failed"
  FindNode = ""
End Function

' ---------------------------------------------------------------------------
' "where node" through cmd.exe, capturing the answer in a temp file.
' ---------------------------------------------------------------------------

Function WhereNode()
  Dim tempFile, cmd, text, firstLine, stream
  WhereNode = ""

  On Error Resume Next
  tempFile = shell.ExpandEnvironmentStrings("%TEMP%") & "\anime-tracker-where-node.txt"
  cmd = "cmd /c where node > " & q & tempFile & q & " 2>&1"
  shell.Run cmd, 0, True

  If fso.FileExists(tempFile) Then
    Set stream = fso.OpenTextFile(tempFile, 1)
    If Err.Number = 0 Then
      If Not stream.AtEndOfStream Then
        text = stream.ReadLine()
        firstLine = Trim(text)
        If fso.FileExists(firstLine) Then WhereNode = firstLine
      End If
      stream.Close
    End If
    fso.DeleteFile tempFile, True
  End If
  Err.Clear
  On Error GoTo 0
End Function

' ---------------------------------------------------------------------------
' Probe /api/health to decide whether the server is ready yet
' ---------------------------------------------------------------------------

Function ServerReady(target)
  Dim http
  ServerReady = False

  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  If Err.Number <> 0 Then
    Err.Clear
    Set http = CreateObject("MSXML2.XMLHTTP")
  End If
  If Err.Number <> 0 Then
    Err.Clear
    Exit Function
  End If

  ' Short timeouts: this is only a liveness probe and must not slow down startup
  http.SetTimeouts 800, 800, 800, 800
  http.Open "GET", target & "/api/health", False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then ServerReady = True
  End If

  Err.Clear
  On Error GoTo 0
End Function

' ---------------------------------------------------------------------------
' Chinese message text, assembled from Unicode code points.
' DO NOT replace these with literal Chinese: see the header comment.
' ---------------------------------------------------------------------------

Function MsgText(key)
  Select Case key
    Case "errNoServerTs"
      ' cannot find the project file
      MsgText = W("65E0 6CD5 627E 5230 9879 76EE 6587 4EF6") & ": src\server\server.ts"
    Case "errNoNode"
      MsgText = W("6CA1 6709 627E 5230 53EF 7528 7684") & " node.exe" & vbCrLf & vbCrLf & _
                W("8BF7 5148 5B89 88C5") & " Node.js" & W("FF08 9700 8981") & " 22.18 " & W("4EE5 4E0A FF09") & _
                vbCrLf & W("6216 8005 76F4 63A5 8FD0 884C") & ": desktop\start-anime-calendar-debug.cmd"
    Case "errSpawn"
      MsgText = W("65E0 6CD5 542F 52A8 670D 52A1 8FDB 7A0B") & " node.exe"
    Case "errTimeout"
      MsgText = W("670D 52A1 542F 52A8 8D85 65F6 FF08 7B49 5F85 4E86") & " 30 " & W("79D2 FF09") & vbCrLf & vbCrLf & _
                W("8BF7 7528 8C03 8BD5 5165 53E3 67E5 770B 5177 4F53 62A5 9519") & ":" & vbCrLf & _
                "  desktop\start-anime-calendar-debug.cmd"
    Case "errNoBrowser"
      ' server is up, but no usable browser was found; open this address manually
      MsgText = W("670D 52A1 5DF2 542F 52A8 FF0C 4F46 6CA1 627E 5230 53EF 7528 7684 6D4F 89C8 5668") & vbCrLf & _
                W("8BF7 624B 52A8 6253 5F00 4E0B 9762 7684 5730 5740") & ":"
    Case "logHint"
      MsgText = W("8BE6 7EC6 65E5 5FD7") & ":"
    Case Else
      MsgText = key
  End Select
End Function

' Build a string from space-separated hex Unicode code points.
Function W(codePoints)
  Dim parts, part, index, result
  parts = Split(Trim(codePoints), " ")
  result = ""
  For index = 0 To UBound(parts)
    part = Trim(parts(index))
    If part <> "" Then result = result & ChrW(CLng("&H" & part))
  Next
  W = result
End Function
