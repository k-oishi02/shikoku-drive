# SHIORI_app Test Runner
# Executes test suites using Node.js built-in test runner (node:test)

$ErrorActionPreference = "Stop"

$nodeExe = $null

if (Get-Command node -ErrorAction SilentlyContinue) {
    try {
        $null = & node -v
        $nodeExe = "node"
    } catch {
        $nodeExe = $null
    }
}

if (-not $nodeExe) {
    $fallbackPath = "C:\Users\ranma\AppData\Local\ms-playwright-go\1.57.0\node.exe"
    if (Test-Path $fallbackPath) {
        $nodeExe = $fallbackPath
    } else {
        Write-Error "Node.js executable not found on PATH or at fallback location: $fallbackPath"
        exit 1
    }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$testTarget = if ($args.Count -gt 0) { $args } else { @("tests/draft-validation.test.js", "tests/trip-core.test.js", "tests/settlement.test.js", "tests/day-planner.test.js", "tests/itinerary-calc.test.js") }

# Filter to targets that actually exist or glob pattern
$existingTargets = @()
foreach ($target in $testTarget) {
    if ($target -match "\*") {
        $existingTargets += $target
    } elseif (Test-Path $target) {
        $existingTargets += $target
    }
}

if ($existingTargets.Count -eq 0) {
    $existingTargets = @("tests/*.test.js")
}

& $nodeExe --test @existingTargets
exit $LASTEXITCODE
