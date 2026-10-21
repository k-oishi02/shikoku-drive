param(
    [switch]$Silent
)

$appDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $appDirectory '.shiori-server.pid'
$portFile = Join-Path $appDirectory '.shiori-server.port'
$portConfigFile = Join-Path $appDirectory 'app-port.json'

function Get-AppPort {
    $defaultPort = 4173
    if (Test-Path -LiteralPath $portConfigFile -PathType Leaf) {
        try {
            $configured = Get-Content -LiteralPath $portConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $port = [int]$configured.port
            if ($port -ge 1024 -and $port -le 65535) { return $port }
        } catch {}
    }
    return $defaultPort
}

$appPort = Get-AppPort
if (Test-Path -LiteralPath $portFile -PathType Leaf) {
    try {
        $p = [int]((Get-Content -LiteralPath $portFile -Raw).Trim())
        if ($p -ge 1024 -and $p -le 65535) { $appPort = $p }
    } catch {}
}

# 1. PIDファイルからのプロセス終了 (SHIORI_app または serve.py であることを検証)
if (Test-Path -LiteralPath $pidFile) {
    try {
        $serverPid = [int]((Get-Content -LiteralPath $pidFile -Raw).Trim())
        if ($serverPid -gt 0) {
            $cimProc = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid" -ErrorAction SilentlyContinue
            if ($cimProc -and ($cimProc.CommandLine -like "*SHIORI_app*" -or $cimProc.CommandLine -like "*serve.py*")) {
                & taskkill /PID $serverPid /T /F 2>$null | Out-Null
            }
        }
    } catch {}
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue

# 2. ポート4173リッスンプロセスの検証と安全終了
try {
    $connections = Get-NetTCPConnection -LocalPort $appPort -ErrorAction SilentlyContinue | Where-Object State -eq 'Listen'
    foreach ($conn in $connections) {
        if ($conn.OwningProcess -gt 0) {
            $cimProc = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)" -ErrorAction SilentlyContinue
            if ($cimProc -and ($cimProc.CommandLine -like "*SHIORI_app*" -or $cimProc.CommandLine -like "*serve.py*")) {
                & taskkill /PID $conn.OwningProcess /T /F 2>$null | Out-Null
            }
        }
    }
} catch {}

# 3. 残存 serve.py プロセスの安全検出と終了
try {
    $pyProcs = Get-CimInstance Win32_Process | Where-Object {
        $_.Name -like "*python*" -and ($_.CommandLine -like "*SHIORI_app*" -and $_.CommandLine -like "*serve.py*")
    }
    foreach ($p in $pyProcs) {
        & taskkill /PID $p.ProcessId /T /F 2>$null | Out-Null
    }
} catch {}

if (-not $Silent) {
    Add-Type -AssemblyName PresentationFramework -ErrorAction SilentlyContinue
    [System.Windows.MessageBox]::Show(
        "SHIORI local server has stopped.",
        'SHIORI', 'OK', 'Information'
    ) | Out-Null
}
