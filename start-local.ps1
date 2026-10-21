[CmdletBinding()]
param()

$shioriRoot = Split-Path -Parent $PSCommandPath
$configPath = Join-Path $shioriRoot 'app-port.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Port config was not found: $configPath"
}

$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$shioriHost = [string]$config.host
$shioriPort = [int]$config.port
$listener = Get-NetTCPConnection -LocalPort $shioriPort -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  throw "localhost:$shioriPort is already in use. Check C:\My app\localhost-ports.json."
}

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
  throw 'Python was not found. Install Python 3 or use another static server with the app-port.json port.'
}

Write-Host ('SHIORI is serving at http://{0}:{1}. Stop with Ctrl+C.' -f $shioriHost, $shioriPort)
Push-Location $shioriRoot
try {
  & $python.Source -m http.server $shioriPort --bind $shioriHost
} finally {
  Pop-Location
}
