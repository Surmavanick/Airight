param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectDir

function Get-ConfiguredPort {
    $value = $env:PORT
    $envFile = Join-Path $projectDir ".env"
    if (-not $value -and (Test-Path -LiteralPath $envFile)) {
        foreach ($line in Get-Content -LiteralPath $envFile) {
            $match = [regex]::Match($line, '^\s*PORT\s*=\s*(.*?)\s*$')
            if ($match.Success) {
                $value = $match.Groups[1].Value.Trim('"', "'")
                break
            }
        }
    }
    $port = 0
    if (-not [int]::TryParse($value, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        return 8000
    }
    return $port
}

$port = Get-ConfiguredPort
$baseUrl = "http://127.0.0.1:$port"
$adminUrl = "$baseUrl/admin/"
$status = $null

try {
    $status = Invoke-RestMethod -Uri "$baseUrl/api/status" -TimeoutSec 3
} catch {
    $status = $null
}

if ($status) {
    $healthy = $status.online -and $status.worker.worker -and
        $status.worker.preflight.ready -and -not $status.workerError
    if ($healthy) {
        if (-not $NoBrowser) {
            Start-Process $adminUrl
        }
        Write-Host "Aright is already running at $adminUrl" -ForegroundColor Green
        exit 0
    }

    if ($status.provider -eq "self-hosted-open-models") {
        $details = if ($status.workerError) {
            $status.workerError
        } elseif ($status.worker.preflight.errors) {
            $status.worker.preflight.errors -join " "
        } else {
            "The model worker did not pass its health check."
        }
        throw "An unhealthy Aright service is already using port $port. Close that server window/process, then run start-aright.cmd again. Details: $details"
    }

    throw "Port $port is already in use by another service. Change PORT in .env or stop that service."
}

$setupScript = Join-Path $projectDir "setup-models.ps1"
& powershell -NoProfile -ExecutionPolicy Bypass -File $setupScript -Check
if ($LASTEXITCODE -ne 0) {
    Write-Host "The detector environment is missing or stale; repairing it now..." -ForegroundColor Yellow
    & powershell -NoProfile -ExecutionPolicy Bypass -File $setupScript
    if ($LASTEXITCODE -ne 0) {
        throw "Detector setup failed with exit code $LASTEXITCODE."
    }
}

$logDir = Join-Path $projectDir "tmp"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$stdoutLog = Join-Path $logDir "aright-server.log"
$stderrLog = Join-Path $logDir "aright-server-error.log"

Write-Host "Starting Aright and waiting for the detector preflight..." -ForegroundColor Cyan
$nodeProcess = Start-Process -FilePath "node" -ArgumentList @("server.js") -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
$healthyStatus = $null
$failure = ""

for ($attempt = 0; $attempt -lt 90; $attempt++) {
    $nodeProcess.Refresh()
    if ($nodeProcess.HasExited) {
        $failure = "The Node server exited with code $($nodeProcess.ExitCode)."
        break
    }
    try {
        $candidate = Invoke-RestMethod -Uri "$baseUrl/api/status" -TimeoutSec 2
        if ($candidate.online -and $candidate.worker.worker -and
            $candidate.worker.preflight.ready -and -not $candidate.workerError) {
            $healthyStatus = $candidate
            break
        }
        if ($candidate.workerError) {
            $failure = $candidate.workerError
            break
        }
        if ($candidate.worker.preflight.ready -eq $false) {
            $failure = $candidate.worker.preflight.errors -join " "
            break
        }
    } catch {
        # The HTTP listener and worker may still be starting.
    }
    Start-Sleep -Milliseconds 500
}

if (-not $healthyStatus) {
    if (-not $nodeProcess.HasExited) {
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($nodeProcess.Id)" -ErrorAction SilentlyContinue
        foreach ($child in $children) {
            if ($child.Name -eq "python.exe" -and $child.CommandLine -match "ml_worker\.py") {
                Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
        Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if (-not $failure) {
        $failure = "The detector service did not pass its health check within 45 seconds."
    }
    $logTail = if (Test-Path -LiteralPath $stderrLog) {
        (Get-Content -LiteralPath $stderrLog -Tail 12 -ErrorAction SilentlyContinue) -join " "
    } else {
        ""
    }
    throw "$failure Logs: $stderrLog $logTail"
}

Set-Content -LiteralPath (Join-Path $logDir "aright-server.pid") -Value $nodeProcess.Id -Encoding ASCII
if (-not $NoBrowser) {
    Start-Process $adminUrl
}
Write-Host "Aright is healthy and running at $adminUrl" -ForegroundColor Green
Write-Host "Server logs: $stdoutLog and $stderrLog" -ForegroundColor DarkGray
