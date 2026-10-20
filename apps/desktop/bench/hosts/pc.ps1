# apps/desktop/bench/hosts/pc.ps1
#
# The Windows side of the bench's remote app host (hosts/remote.ts). The
# runner uploads this file to <bench root>\bin\ and runs one operation per SSH
# call:
#
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File pc.ps1 -Op <op> -ArgsB64 <base64 JSON>
#
# Arguments travel as base64 JSON so no quoting survives cmd.exe; the result is
# one line, '@@RESULT@@' + JSON, and a failure is '@@ERROR@@' + text with exit 1.
#
# Ground rules (README "Remote app host"):
#   - Everything the bench creates lives under %USERPROFILE%\weftcut-bench.
#   - The user's own profile (%APPDATA%\WeftCut) is only READ: config files are
#     read and rewritten into the bench profile, model files are hard-linked
#     out of it. Nothing is written into it, and its mcp_auth.json is never read.
#   - Only processes this bench started are stopped: the app's root process is
#     identified by its recorded pid AND a command line naming the run's own
#     profile directory.

param(
  [Parameter(Mandatory = $true)][string]$Op,
  [string]$ArgsB64 = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

$A = $null
if ($ArgsB64) { $A = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgsB64)) | ConvertFrom-Json }
$Root = Join-Path $env:USERPROFILE 'weftcut-bench'
$UserProfileDir = Join-Path $env:APPDATA 'WeftCut'
$TaskPath = '\WeftCutBench\'
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Out-Result($obj) {
  Write-Output ('@@RESULT@@' + (ConvertTo-Json -InputObject $obj -Depth 30 -Compress))
}

function Run-Dir([string]$run) {
  if ($run -notmatch '^[A-Za-z0-9._-]+$') { throw "bad run slug '$run'" }
  return (Join-Path (Join-Path $Root 'runs') $run)
}

function Write-Text([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, $Utf8) }
# Not Get-Content: in PowerShell 5.1 its strings carry PSPath/PSDrive/PSProvider
# note properties, and ConvertTo-Json walks into that object graph for minutes.
function Read-Text([string]$path) { return [IO.File]::ReadAllText($path, $Utf8) }
function Read-Json([string]$path) { return (Read-Text $path | ConvertFrom-Json) }

function Node-Exe {
  $candidates = @()
  if ($A -and $A.node) { $candidates += $A.node }
  $candidates += (Join-Path $env:APPDATA 'fnm\node-versions\v24.20.0\installation\node.exe')
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw 'node.exe not found (pass args.node or install it under fnm)'
}

# Every descendant of $rootPid (inclusive), from one Win32_Process snapshot.
function Process-Tree([int]$rootPid) {
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, SessionId, CommandLine, ExecutablePath)
  $tree = @()
  $frontier = @($rootPid)
  $seen = @{}
  while ($frontier.Count) {
    $next = @()
    foreach ($id in $frontier) {
      if ($seen.ContainsKey($id)) { continue }
      $seen[$id] = $true
      $p = $all | Where-Object { $_.ProcessId -eq $id }
      if ($p) { $tree += $p }
      $next += @($all | Where-Object { $_.ParentProcessId -eq $id -and $_.ProcessId -ne $id } | ForEach-Object { $_.ProcessId })
    }
    $frontier = $next
  }
  return ,$tree
}

# Processes whose command line names this run's directory: the app and every
# helper it spawned with a path inside the run (ffmpeg on project media, ...).
function Run-Processes([string]$runDir) {
  $needle = $runDir.ToLowerInvariant()
  return ,@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($needle) } |
    Select-Object ProcessId, ParentProcessId, Name, SessionId)
}

# A native command whose exit and stderr are expected noise (taskkill on a
# process that is already gone). PowerShell 5.1 turns redirected native stderr
# into an error record, which 'Stop' would make fatal.
function Quiet([scriptblock]$block) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $block 2>&1 | Out-Null } finally { $ErrorActionPreference = $old }
}

function Sha256([string]$path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }

# sha256 of a file, cached by full path + size + mtime under <root>\cache.
function Cached-Hash([string]$path, $cache) {
  $item = Get-Item -LiteralPath $path
  $key = '{0}|{1}|{2}' -f $item.FullName, $item.Length, $item.LastWriteTimeUtc.Ticks
  if ($cache.ContainsKey($key)) { return @{ sha256 = $cache[$key]; cached = $true } }
  $h = Sha256 $item.FullName
  $cache[$key] = $h
  return @{ sha256 = $h; cached = $false }
}

function Robocopy-Tree([string]$src, [string]$dst, [string[]]$excludeDirs) {
  $rc = @($src, $dst, '/E', '/COPY:DAT', '/DCOPY:T', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($excludeDirs -and $excludeDirs.Count) { $rc += '/XD'; $rc += $excludeDirs }
  & robocopy.exe @rc | Out-Null
  # robocopy: 0-7 are success variants, 8+ means something was not copied.
  if ($LASTEXITCODE -ge 8) { throw "robocopy $src -> $dst failed with exit $LASTEXITCODE" }
}

function Dir-Bytes([string]$dir) {
  $s = (Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  if ($s) { return [int64]$s } else { return [int64]0 }
}

try {
  switch ($Op) {

    # Host identity, the app build and the tools the bench needs.
    'info' {
      $repo = $A.repo
      $os = Get-CimInstance Win32_OperatingSystem
      $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
      $gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { '{0} (driver {1})' -f $_.Name, $_.DriverVersion })
      $rev = (& git -C $repo describe --always --dirty 2>$null)
      $head = (& git -C $repo rev-parse HEAD 2>$null)
      $out = Join-Path $repo 'apps\desktop\out'
      # Build fingerprint: every file under out\ by name and size (Vite names
      # chunks by content), the main entry's bytes, and the native addons.
      $lines = @(Get-ChildItem -LiteralPath $out -Recurse -File | ForEach-Object { '{0}|{1}' -f $_.FullName.Substring($out.Length), $_.Length } | Sort-Object)
      $lines += 'main=' + (Sha256 (Join-Path $out 'main\index.js'))
      $lines += @(Get-ChildItem -Path (Join-Path $repo 'apps\desktop\native') -Recurse -Depth 1 -Filter '*.node' -File | ForEach-Object { '{0}|{1}|{2}' -f $_.Name, $_.Length, $_.LastWriteTimeUtc.Ticks } | Sort-Object)
      $sha = [Security.Cryptography.SHA256]::Create()
      $build = -join ($sha.ComputeHash($Utf8.GetBytes(($lines -join "`n"))) | ForEach-Object { $_.ToString('x2') })
      Out-Result @{
        computer = $env:COMPUTERNAME; user = (whoami); os = $os.Caption + ' ' + $os.Version
        cpu = $cpu.Name.Trim(); logical_cpus = $cpu.NumberOfLogicalProcessors
        ram_gib = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1); gpus = $gpus
        node = (& (Node-Exe) --version); ffmpeg = ((& ffmpeg -hide_banner -version 2>$null) | Select-Object -First 1)
        app_revision = $rev; app_head = $head; build_sha256 = $build
        electron_present = (Test-Path (Join-Path $repo 'node_modules\electron\dist\electron.exe'))
        main_present = (Test-Path (Join-Path $out 'main\index.js'))
        console_session = ((query user 2>$null) -join "`n")
      }
    }

    # A fresh run directory with an isolated profile seeded from the user's:
    # config files copied with their profile paths re-pointed, model files
    # hard-linked (same volume, no bytes copied), and the active models hashed.
    'prepare' {
      $runDir = Run-Dir $A.run
      if (Test-Path $runDir) { throw "run directory $runDir already exists" }
      $profile = Join-Path $runDir 'profile'
      foreach ($d in @($profile, (Join-Path $runDir 'projects'), (Join-Path $runDir 'work'), (Join-Path $Root 'cache'))) {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
      }
      $seeded = @()
      $linkedFiles = 0; $linkedBytes = [int64]0
      if (Test-Path $UserProfileDir) {
        # Path spellings as they appear inside the JSON files: escaped and raw.
        $fromEsc = $UserProfileDir.Replace('\', '\\'); $toEsc = $profile.Replace('\', '\\')
        foreach ($f in @('speech_config.json', 'vlm_config.json', 'model_settings.json')) {
          $src = Join-Path $UserProfileDir $f
          if (-not (Test-Path $src)) { continue }
          $text = [IO.File]::ReadAllText($src, $Utf8)
          $text = [regex]::Replace($text, [regex]::Escape($fromEsc), $toEsc.Replace('$', '$$'), 'IgnoreCase')
          $text = [regex]::Replace($text, [regex]::Escape($UserProfileDir), $profile.Replace('$', '$$'), 'IgnoreCase')
          Write-Text (Join-Path $profile $f) $text
          $seeded += $f
        }
        $downloads = Join-Path $UserProfileDir 'data\downloads'
        if (Test-Path $downloads) {
          foreach ($file in Get-ChildItem -LiteralPath $downloads -Recurse -File -Force) {
            $rel = $file.FullName.Substring($downloads.Length).TrimStart('\')
            # A half-finished download is the user's business, not the run's.
            if ($rel -match '(^|\\)\.staging-') { continue }
            $dest = Join-Path (Join-Path $profile 'data\downloads') $rel
            New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
            New-Item -ItemType HardLink -Path $dest -Target $file.FullName | Out-Null
            $linkedFiles++; $linkedBytes += $file.Length
          }
        }
      }
      if ($A.memory_mib) {
        Write-Text (Join-Path $profile 'app_settings.json') (ConvertTo-Json -InputObject @{ resource_policy = @{ version = 1; memory_mib = [int]$A.memory_mib } } -Compress)
        $seeded += 'app_settings.json (resource_policy only)'
      }

      # The model set: each family's active profile, its artifacts, and the
      # weight files' sha256 (cached by path+size+mtime: hashed once).
      $models = @()
      $settingsPath = Join-Path $profile 'model_settings.json'
      if (Test-Path $settingsPath) {
        $ms = Read-Json $settingsPath
        $cachePath = Join-Path $Root 'cache\model-hashes.json'
        $cache = @{}
        if (Test-Path $cachePath) { (Read-Json $cachePath).PSObject.Properties | ForEach-Object { $cache[$_.Name] = $_.Value } }
        foreach ($fam in $ms.active.PSObject.Properties) {
          $p = $ms.profiles | Where-Object { $_.id -eq $fam.Value } | Select-Object -First 1
          if (-not $p) { continue }
          $arts = @()
          foreach ($artifact in @($p.artifacts)) {
            $adir = Join-Path $UserProfileDir ('data\downloads\' + $artifact)
            if (-not (Test-Path $adir)) { $arts += @{ id = $artifact; installed = $false }; continue }
            $ver = Get-ChildItem -LiteralPath $adir -Directory | Where-Object { $_.Name -notlike '.staging-*' } | Select-Object -First 1
            $manifest = if ($ver) { Join-Path $ver.FullName 'manifest.json' } else { $null }
            $weights = @()
            if ($ver) {
              foreach ($w in Get-ChildItem -LiteralPath $ver.FullName -Recurse -File | Where-Object { $_.Extension -in '.bin', '.gguf', '.onnx' }) {
                $h = Cached-Hash $w.FullName $cache
                $weights += @{ file = $w.FullName.Substring($ver.FullName.Length).TrimStart('\'); bytes = $w.Length; sha256 = $h.sha256; hash_cached = $h.cached }
              }
            }
            $arts += @{ id = $artifact; version = $(if ($ver) { $ver.Name } else { $null }); installed = [bool]($manifest -and (Test-Path $manifest))
              manifest_sha256 = $(if ($manifest -and (Test-Path $manifest)) { Sha256 $manifest } else { $null }); weights = $weights }
          }
          $models += @{ family = $fam.Name; id = $p.id; backend = $p.backend; locality = $p.locality; artifacts = $arts }
        }
        Write-Text $cachePath (ConvertTo-Json -InputObject $cache -Compress)
      }
      Out-Result @{ run_dir = $runDir; profile = $profile; seeded = $seeded; linked_files = $linkedFiles; linked_bytes = $linkedBytes; models = $models }
    }

    # Start the app in the interactive console session. SSH logons live in
    # session 0, which has no desktop and no GPU for GUI processes; a scheduled
    # task with an Interactive principal runs in the user's logged-on session
    # (what `schtasks /IT` means) without a stored password. The task runs a
    # small wrapper that sets the environment, starts Electron with its output
    # redirected, records the pid and exits; the task is deleted right after.
    'launch' {
      $runDir = Run-Dir $A.run
      $q = { param($s) "'" + ([string]$s).Replace("'", "''") + "'" }
      $lines = @('$ErrorActionPreference = ''Stop''')
      foreach ($prop in $A.env.PSObject.Properties) { $lines += ('$env:{0} = {1}' -f $prop.Name, (& $q $prop.Value)) }
      # As the e2e preflight does: the checkout's own ffmpeg when it was
      # fetched (resources\ffmpeg\win), else whatever is on PATH.
      if ($A.ffmpeg_dir -and (Test-Path (Join-Path $A.ffmpeg_dir 'ffmpeg.exe'))) {
        $lines += ('$env:FFMPEG = {0}' -f (& $q (Join-Path $A.ffmpeg_dir 'ffmpeg.exe')))
        if (Test-Path (Join-Path $A.ffmpeg_dir 'ffprobe.exe')) { $lines += ('$env:FFPROBE = {0}' -f (& $q (Join-Path $A.ffmpeg_dir 'ffprobe.exe'))) }
        $lines += ('$env:PATH = {0} + '';'' + $env:PATH' -f (& $q $A.ffmpeg_dir))
      }
      $argList = ($A.args | ForEach-Object { '"' + $_ + '"' }) -join ' '
      $lines += ('$p = Start-Process -FilePath {0} -ArgumentList {1} -WorkingDirectory {2} -RedirectStandardOutput {3} -RedirectStandardError {4} -PassThru' -f `
        (& $q $A.electron), (& $q $argList), (& $q $A.cwd), (& $q (Join-Path $runDir 'app.out.log')), (& $q (Join-Path $runDir 'app.err.log')))
      $lines += ('Set-Content -LiteralPath {0} -Value $p.Id -Encoding ascii' -f (& $q (Join-Path $runDir 'app.pid')))
      Write-Text (Join-Path $runDir 'launch.ps1') ($lines -join "`r`n")

      $name = 'WeftCutBench-' + $A.run
      $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f (Join-Path $runDir 'launch.ps1'))
      $principal = New-ScheduledTaskPrincipal -UserId (whoami) -LogonType Interactive -RunLevel Limited
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0)
      Register-ScheduledTask -TaskName $name -TaskPath $TaskPath -Action $action -Principal $principal -Settings $settings -Force | Out-Null
      Start-ScheduledTask -TaskName $name -TaskPath $TaskPath
      $pidFile = Join-Path $runDir 'app.pid'
      $deadline = (Get-Date).AddSeconds(60)
      while (-not (Test-Path $pidFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
      # The wrapper has done its job once the pid is written; wait for it to
      # exit so the task is idle, then delete it.
      $deadline2 = (Get-Date).AddSeconds(20)
      while ((Get-ScheduledTask -TaskName $name -TaskPath $TaskPath).State -eq 'Running' -and (Get-Date) -lt $deadline2) { Start-Sleep -Milliseconds 250 }
      $taskInfo = Get-ScheduledTaskInfo -TaskName $name -TaskPath $TaskPath
      Unregister-ScheduledTask -TaskName $name -TaskPath $TaskPath -Confirm:$false
      if (-not (Test-Path $pidFile)) { throw "the launch task did not record a pid within 60 s (last task result $($taskInfo.LastTaskResult))" }
      $appPid = [int](Read-Text $pidFile).Trim()
      $proc = Get-Process -Id $appPid -ErrorAction SilentlyContinue
      Out-Result @{ pid = $appPid; session_id = $(if ($proc) { $proc.SessionId } else { $null }); alive = [bool]$proc
        task = $TaskPath + $name; task_result = $taskInfo.LastTaskResult; launcher_session = (Get-Process -Id $PID).SessionId }
    }

    # The MCP rendezvous of THIS run's profile. Returned over the SSH channel
    # only; the runner keeps the token in memory.
    'wait-auth' {
      $runDir = Run-Dir $A.run
      $auth = Join-Path $runDir 'profile\mcp_auth.json'
      $deadline = (Get-Date).AddSeconds([int]$A.timeout_s)
      while ((Get-Date) -lt $deadline) {
        if (Test-Path $auth) {
          try { $j = Read-Json $auth; if ($j.token -and $j.port) { Out-Result @{ port = [int]$j.port; token = $j.token }; break } } catch {}
        }
        if (-not (Get-Process -Id ([int]$A.pid) -ErrorAction SilentlyContinue)) {
          $err = if (Test-Path (Join-Path $runDir 'app.err.log')) { (Get-Content -LiteralPath (Join-Path $runDir 'app.err.log') -Tail 40) -join "`n" } else { '' }
          throw "the app (pid $($A.pid)) exited before writing mcp_auth.json. stderr tail:`n$err"
        }
        Start-Sleep -Milliseconds 300
      }
      if (-not (Test-Path $auth)) { throw "no mcp_auth.json in the run profile after $($A.timeout_s) s" }
    }

    # Where the app runs and what GPU it got: the session of its process tree,
    # the tree's entries in nvidia-smi's process table, and the decode
    # capabilities the app probed into its profile.
    'status' {
      $runDir = Run-Dir $A.run
      $tree = Process-Tree ([int]$A.pid)
      $ids = @($tree | ForEach-Object { [string]$_.ProcessId })
      $smi = @()
      $nv = Get-Command nvidia-smi -ErrorAction SilentlyContinue
      if ($nv) {
        $smiAll = @(& nvidia-smi 2>$null)
        $smi = @($smiAll | Where-Object { $line = $_; ($ids | Where-Object { $line -match ('\s' + $_ + '\s') }).Count -gt 0 })
        $gpuLine = @(& nvidia-smi --query-gpu=name,driver_version,utilization.gpu,memory.used --format=csv,noheader 2>$null)
      }
      $cap = Join-Path $runDir 'profile\decode_capability.json'
      Out-Result @{
        sessions = @($tree | ForEach-Object { $_.SessionId } | Sort-Object -Unique)
        processes = @($tree | ForEach-Object { @{ pid = $_.ProcessId; name = $_.Name; session = $_.SessionId; type = $(if ($_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'main' }) } })
        nvidia_smi_processes = $smi; gpu = $gpuLine
        decode_capability = $(if (Test-Path $cap) { Read-Json $cap } else { $null })
        app_settings = $(if (Test-Path (Join-Path $runDir 'profile\app_settings.json')) { Read-Json (Join-Path $runDir 'profile\app_settings.json') } else { $null })
      }
    }

    # Stop exactly what this run started: the recorded app pid, only if its
    # command line names this run's profile, then its process tree, then any
    # straggler whose command line names the run directory. Graceful first.
    'stop' {
      $runDir = Run-Dir $A.run
      $profile = (Join-Path $runDir 'profile').ToLowerInvariant()
      $killed = @(); $refused = $null
      $rootProc = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f [int]$A.pid) -ErrorAction SilentlyContinue
      if ($rootProc) {
        if (-not ($rootProc.CommandLine -and $rootProc.CommandLine.ToLowerInvariant().Contains($profile))) {
          $refused = "pid $($A.pid) ($($rootProc.Name)) does not name this run's profile; not touching it"
        } else {
          $tree = Process-Tree ([int]$A.pid)
          $killed = @($tree | ForEach-Object { @{ pid = $_.ProcessId; name = $_.Name } })
          Quiet { taskkill.exe /PID ([int]$A.pid) /T }
          $deadline = (Get-Date).AddSeconds(10)
          while ((Get-Process -Id ([int]$A.pid) -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
          foreach ($p in $tree) { if (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue) { Quiet { taskkill.exe /PID $p.ProcessId /T /F } } }
        }
      }
      Start-Sleep -Milliseconds 500
      foreach ($p in (Run-Processes $runDir)) { Quiet { taskkill.exe /PID $p.ProcessId /T /F }; $killed += @{ pid = $p.ProcessId; name = $p.Name; straggler = $true } }
      Get-ScheduledTask -TaskPath $TaskPath -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -eq ('WeftCutBench-' + $A.run) } |
        ForEach-Object { Unregister-ScheduledTask -TaskName $_.TaskName -TaskPath $TaskPath -Confirm:$false }
      Start-Sleep -Milliseconds 500
      Out-Result @{ killed = $killed; refused = $refused; leftovers = (Run-Processes $runDir)
        tasks_left = @(Get-ScheduledTask -TaskPath $TaskPath -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName }) }
    }

    'cleanup' {
      $runDir = Run-Dir $A.run
      if ($A.keep) { Out-Result @{ kept = $runDir }; break }
      # Hard links only: removing them leaves the user's model files intact.
      if (Test-Path $runDir) { Remove-Item -LiteralPath $runDir -Recurse -Force }
      Out-Result @{ removed = $runDir; exists = (Test-Path $runDir) }
    }

    # Everything of the bench's that is alive or registered on this PC.
    'strays' {
      $needle = $Root.ToLowerInvariant()
      # Not this query itself (powershell running pc.ps1, and its cmd.exe parent).
      $self = @($PID, (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").ParentProcessId)
      Out-Result @{
        processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -notin $self -and $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($needle) } |
          ForEach-Object { @{ pid = $_.ProcessId; name = $_.Name; session = $_.SessionId } })
        tasks = @(Get-ScheduledTask -TaskPath $TaskPath -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName })
        runs = @(Get-ChildItem -LiteralPath (Join-Path $Root 'runs') -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
      }
    }

    # Fetch + verify fixtures with the shipped fixtures.mjs, into <root>\cache.
    'fixtures' {
      $node = Node-Exe
      $env:WEFTCUT_BENCH_CACHE = Join-Path $Root 'cache\fixtures'
      # fetch.mjs reports progress on stderr; under 'Stop' PowerShell 5.1
      # would turn the first such line into a terminating error.
      $ErrorActionPreference = 'Continue'
      $out = & $node (Join-Path $Root 'fixtures\fetch.mjs') @($A.ids) 2>&1
      $code = $LASTEXITCODE
      $ErrorActionPreference = 'Stop'
      $paths = @{}
      foreach ($line in $out) { if ("$line" -match '^ok\s+(\S+)\s+.*\s(\S:\\.+)$') { $paths[$Matches[1]] = $Matches[2] } }
      if ($code -ne 0) { throw "fetch.mjs exited $code`n$($out -join "`n")" }
      Out-Result @{ paths = $paths; log = @($out | ForEach-Object { "$_" }) }
    }

    'template-status' {
      $meta = Join-Path $Root ('templates\' + $A.key + '\template.json')
      if (Test-Path $meta) { Out-Result @{ meta = (Read-Json $meta); baseline = (Read-Text (Join-Path (Split-Path $meta) 'baseline.json')) } }
      else { Out-Result @{ meta = $null } }
    }

    # Copy a settled project folder (with its Cache\) into the template store,
    # minus Backups\ and Logs\, under a temp name renamed into place at the end.
    'template-save' {
      $dir = Join-Path $Root ('templates\' + $A.key)
      $tmp = $dir + '.tmp'
      if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
      New-Item -ItemType Directory -Force -Path $tmp | Out-Null
      $sw = [Diagnostics.Stopwatch]::StartNew()
      Robocopy-Tree $A.project_dir (Join-Path $tmp 'project') @('Backups', 'Logs')
      # Uploaded beside the run by sftp: a baseline outgrows cmd.exe's 8191-char line.
      Copy-Item -LiteralPath $A.meta_file -Destination (Join-Path $tmp 'template.json')
      Copy-Item -LiteralPath $A.baseline_file -Destination (Join-Path $tmp 'baseline.json')
      if (Test-Path $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
      Rename-Item -LiteralPath $tmp -NewName (Split-Path $dir -Leaf)
      Out-Result @{ ms = $sw.ElapsedMilliseconds; bytes = (Dir-Bytes (Join-Path $dir 'project')); dir = $dir }
    }

    'template-restore' {
      $src = Join-Path $Root ('templates\' + $A.key + '\project')
      if (-not (Test-Path $src)) { throw "no template $($A.key)" }
      if (Test-Path $A.dest) { throw "$($A.dest) already exists" }
      $sw = [Diagnostics.Stopwatch]::StartNew()
      Robocopy-Tree $src $A.dest @()
      Out-Result @{ ms = $sw.ElapsedMilliseconds; bytes = (Dir-Bytes $A.dest) }
    }

    default { throw "unknown op '$Op'" }
  }
} catch {
  Write-Output ('@@ERROR@@' + ($_ | Out-String))
  exit 1
}
