param(
    [switch]$Check
)

$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectDir

$pythonSeries = "3.12"
$pipVersion = "25.3"
$torchSpec = "torch==2.9.1 torchvision==0.24.1 cpu"
$setupSchema = "aright-detectors-v3"
$venvPython = Join-Path $projectDir ".aright-venv\Scripts\python.exe"
$readyStamp = Join-Path $projectDir ".aright-venv\aright-models.ready"

function Invoke-CheckedNative {
    param(
        [Parameter(Mandatory = $true)][string]$Step,
        [Parameter(Mandatory = $true)][scriptblock]$Command
    )
    & $Command
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        throw "$Step failed with exit code $code."
    }
}

function Get-SetupFingerprint {
    $material = @(
        "schema=$setupSchema"
        "python=$pythonSeries"
        "pip=$pipVersion"
        "torch=$torchSpec"
        "requirements=$((Get-FileHash -LiteralPath (Join-Path $projectDir 'requirements-ml.txt') -Algorithm SHA256).Hash.ToLowerInvariant())"
        "worker=$((Get-FileHash -LiteralPath (Join-Path $projectDir 'ml_worker.py') -Algorithm SHA256).Hash.ToLowerInvariant())"
        "verifier=$((Get-FileHash -LiteralPath (Join-Path $projectDir 'verify_environment.py') -Algorithm SHA256).Hash.ToLowerInvariant())"
        "setup=$((Get-FileHash -LiteralPath (Join-Path $projectDir 'setup-models.ps1') -Algorithm SHA256).Hash.ToLowerInvariant())"
    ) -join "`n"
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($material)
        return -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") })
    } finally {
        $sha.Dispose()
    }
}

function Assert-PythonSeries {
    Invoke-CheckedNative "Python $pythonSeries environment check" {
        & $venvPython -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)"
    }
}

function Assert-ExactDependencies {
    Invoke-CheckedNative "Pinned dependency version check" { & $venvPython verify_environment.py }
}

$expectedFingerprint = Get-SetupFingerprint

if ($Check) {
    if (-not (Test-Path -LiteralPath $venvPython)) {
        throw "The Aright Python environment is missing."
    }
    if (-not (Test-Path -LiteralPath $readyStamp)) {
        throw "The detector setup marker is missing."
    }
    $stamp = Get-Content -LiteralPath $readyStamp -Raw
    if ($stamp -notmatch "(?m)^schema=$([regex]::Escape($setupSchema))\r?$" -or
        $stamp -notmatch "(?m)^fingerprint=$([regex]::Escape($expectedFingerprint))\r?$") {
        throw "The detector setup marker is stale for the current code or dependency pins."
    }
    Assert-PythonSeries
    Invoke-CheckedNative "Dependency consistency check" { & $venvPython -m pip check }
    Assert-ExactDependencies
    Invoke-CheckedNative "Pinned model preflight" { & $venvPython ml_worker.py --check }
    Write-Host "Aright detector setup is current and verified." -ForegroundColor Green
    exit 0
}

if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host "Creating the Aright Python environment..." -ForegroundColor Cyan
    Invoke-CheckedNative "Python environment creation" { py -3.12 -m venv .aright-venv }
}

Assert-PythonSeries

if (Test-Path -LiteralPath $readyStamp) {
    Remove-Item -LiteralPath $readyStamp -Force
}

Write-Host "Installing pinned CPU model dependencies..." -ForegroundColor Cyan
Invoke-CheckedNative "pip bootstrap" { & $venvPython -m pip install "pip==$pipVersion" }
Invoke-CheckedNative "PyTorch installation" { & $venvPython -m pip install torch==2.9.1 torchvision==0.24.1 --index-url https://download.pytorch.org/whl/cpu }
Invoke-CheckedNative "Detector dependency installation" { & $venvPython -m pip install -r requirements-ml.txt }
Invoke-CheckedNative "Dependency consistency check" { & $venvPython -m pip check }
Assert-ExactDependencies

Write-Host "Downloading and verifying the pinned detector models..." -ForegroundColor Cyan
Invoke-CheckedNative "Detector model preload" { & $venvPython ml_worker.py --preload }
Invoke-CheckedNative "Pinned model preflight" { & $venvPython ml_worker.py --check }

@(
    "schema=$setupSchema"
    "fingerprint=$expectedFingerprint"
    "python=$pythonSeries"
    "completed=$(Get-Date -Format o)"
) | Set-Content -LiteralPath $readyStamp -Encoding UTF8

Write-Host "Aright detector setup is complete." -ForegroundColor Green
