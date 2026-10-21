param(
    [switch]$NoBrowser,
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'
$appDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
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

function Test-ShioriHealth {
    param([int]$Port)
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 1 -ErrorAction Stop
        return ($resp.app -eq 'SHIORI')
    } catch { return $false }
}

function Get-RunningPort {
    param([int]$DefaultPort)
    $portFile = Join-Path $appDirectory '.shiori-server.port'
    if (Test-Path -LiteralPath $portFile -PathType Leaf) {
        try {
            $p = [int]((Get-Content -LiteralPath $portFile -Raw).Trim())
            if ($p -ge 1024 -and $p -le 65535 -and (Test-ShioriHealth -Port $p)) {
                return $p
            }
        } catch {}
    }
    if (Test-ShioriHealth -Port $DefaultPort) {
        return $DefaultPort
    }
    return 0
}

try {
    # 1. Check if SHIORI is already running
    $runningPort = Get-RunningPort -DefaultPort $appPort

    if ($runningPort -eq 0) {
        # 2. Check if another server is occupying port
        $occupied = Get-NetTCPConnection -LocalPort $appPort -State Listen -ErrorAction SilentlyContinue
        if ($occupied) {
            throw "Port $appPort is occupied by another application. Please check C:\My app\localhost-ports.json."
        }

        # 3. Start serve.py in background
        $pythonScript = Join-Path $appDirectory 'serve.py'
        Start-Process -FilePath 'python.exe' -ArgumentList "`"$pythonScript`"" -WorkingDirectory $appDirectory -WindowStyle Hidden

        # 4. Wait for server (max 10 sec)
        $ready = $false
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 500
            $runningPort = Get-RunningPort -DefaultPort $appPort
            if ($runningPort -gt 0) {
                $ready = $true
                break
            }
        }
        if (-not $ready) {
            throw 'Failed to start SHIORI local server or port binding timed out.'
        }
    }

    # 5. Open browser
    $targetUrl = "http://localhost:$runningPort"
    if (-not $NoBrowser) {
        Start-Process $targetUrl
    }
} catch {
    if ($Silent) {
        Write-Error $_.Exception.Message
    } else {
        Add-Type -AssemblyName PresentationFramework -ErrorAction SilentlyContinue
        [System.Windows.MessageBox]::Show(
            "Error starting SHIORI:`n`n$($_.Exception.Message)",
            'SHIORI', 'OK', 'Error'
        ) | Out-Null
    }
    exit 1
}
