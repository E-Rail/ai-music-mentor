#requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WebDir = Join-Path $ProjectDir "apps\web"
$ApiDir = Join-Path $ProjectDir "apps\api"
$AppUrl = "http://127.0.0.1:8000"
$ReadyUrl = "$AppUrl/api/v1/readiness"
$ServerProcess = $null

function Find-Application {
    param([string[]]$Names)

    foreach ($Name in $Names) {
        $Command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -ne $Command) {
            return $Command.Source
        }
    }
    return $null
}

function Invoke-Native {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
    }
}

function Test-Ready {
    try {
        $Response = Invoke-WebRequest -Uri $ReadyUrl -UseBasicParsing -TimeoutSec 1
        return $Response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Test-Python {
    param([hashtable]$Python)

    $Probe = "import alembic, defusedxml, dotenv, fastapi, httpx, mido, music21, multipart, numpy, pydantic, sqlalchemy, uvicorn"
    [string[]]$ProbeArgs = @($Python.Prefix) + @("-c", $Probe)
    & $Python.Executable @ProbeArgs *> $null
    return $LASTEXITCODE -eq 0
}

function Find-Python {
    $VenvPython = Join-Path $ProjectDir ".venv\Scripts\python.exe"
    if (Test-Path $VenvPython) {
        $Venv = @{ Executable = $VenvPython; Prefix = @() }
        if (Test-Python $Venv) {
            return $Venv
        }
    }

    $Candidates = @(
        @{ Name = "py.exe"; Prefix = @("-3") },
        @{ Name = "python.exe"; Prefix = @() },
        @{ Name = "python3.exe"; Prefix = @() }
    )

    foreach ($Candidate in $Candidates) {
        $Executable = Find-Application @($Candidate.Name)
        if ($null -eq $Executable) {
            continue
        }
        $Python = @{ Executable = $Executable; Prefix = @($Candidate.Prefix) }
        if (Test-Python $Python) {
            return $Python
        }
    }

    $BasePython = $null
    foreach ($Candidate in $Candidates) {
        $Executable = Find-Application @($Candidate.Name)
        if ($null -eq $Executable) {
            continue
        }
        [string[]]$ProbeArgs = @($Candidate.Prefix) + @("-c", "import sys; assert sys.version_info >= (3, 10)")
        & $Executable @ProbeArgs *> $null
        if ($LASTEXITCODE -eq 0) {
            $BasePython = @{ Executable = $Executable; Prefix = @($Candidate.Prefix) }
            break
        }
    }

    if ($null -eq $BasePython) {
        throw "Python 3.10 or newer is required. Install Python, then run launch.ps1 again."
    }

    if (-not (Test-Path $VenvPython)) {
        Write-Host "Creating a local Python environment..."
        [string[]]$VenvArgs = @($BasePython.Prefix) + @("-m", "venv", (Join-Path $ProjectDir ".venv"))
        Invoke-Native -FilePath $BasePython.Executable -Arguments $VenvArgs | Out-Host
    }

    Write-Host "Installing API dependencies for the first launch..."
    Invoke-Native -FilePath $VenvPython -Arguments @(
        "-m", "pip", "install", "-r", (Join-Path $ApiDir "requirements.txt")
    ) | Out-Host

    $Venv = @{ Executable = $VenvPython; Prefix = @() }
    if (-not (Test-Python $Venv)) {
        throw "The Python environment was created, but required API packages are unavailable."
    }
    return $Venv
}

function Build-Web {
    $Tsc = Join-Path $WebDir "node_modules\.bin\tsc.cmd"
    $Vite = Join-Path $WebDir "node_modules\.bin\vite.cmd"

    Push-Location $WebDir
    try {
        if (-not (Test-Path $Tsc) -or -not (Test-Path $Vite)) {
            if ($null -eq (Find-Application @("node.exe"))) {
                throw "Node.js is required. Install Node.js, then run launch.ps1 again."
            }

            Write-Host "Installing web dependencies for the first launch..."
            $env:CI = "true"
            $Pnpm = Find-Application @("pnpm.cmd", "pnpm.exe")
            $Corepack = Find-Application @("corepack.cmd", "corepack.exe")
            $Npx = Find-Application @("npx.cmd", "npx.exe")

            if ($null -ne $Pnpm) {
                Invoke-Native -FilePath $Pnpm -Arguments @("install", "--frozen-lockfile")
            }
            elseif ($null -ne $Corepack) {
                $env:COREPACK_HOME = Join-Path $ProjectDir "data\corepack"
                New-Item -ItemType Directory -Force -Path $env:COREPACK_HOME | Out-Null
                Invoke-Native -FilePath $Corepack -Arguments @("pnpm", "install", "--frozen-lockfile")
            }
            elseif ($null -ne $Npx) {
                Invoke-Native -FilePath $Npx -Arguments @(
                    "--yes", "pnpm@10.12.1", "install", "--frozen-lockfile"
                )
            }
            else {
                throw "pnpm, Corepack, or npx is required. Reinstall a current Node.js release."
            }
        }

        Invoke-Native -FilePath $Tsc -Arguments @("-b")
        Invoke-Native -FilePath $Vite -Arguments @("build")
    }
    finally {
        Pop-Location
    }
}

if (Test-Ready) {
    Start-Process $AppUrl
    exit 0
}

try {
    Build-Web
    $Python = Find-Python

    Push-Location $ApiDir
    try {
        [string[]]$MigrationArgs = @($Python.Prefix) + @("-m", "alembic", "upgrade", "head")
        Invoke-Native -FilePath $Python.Executable -Arguments $MigrationArgs
    }
    finally {
        Pop-Location
    }

    [string[]]$ServerArgs = @($Python.Prefix) + @(
        "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"
    )
    $ServerProcess = Start-Process -FilePath $Python.Executable -ArgumentList $ServerArgs `
        -WorkingDirectory $ApiDir -NoNewWindow -PassThru

    for ($Attempt = 1; $Attempt -le 1200; $Attempt++) {
        if (Test-Ready) {
            Start-Process $AppUrl
            $ServerProcess.WaitForExit()
            exit $ServerProcess.ExitCode
        }
        if ($ServerProcess.HasExited) {
            exit $ServerProcess.ExitCode
        }
        Start-Sleep -Milliseconds 500
    }

    throw "AI Music Mentor did not become ready within 10 minutes."
}
finally {
    if ($null -ne $ServerProcess -and -not $ServerProcess.HasExited) {
        Stop-Process -Id $ServerProcess.Id -ErrorAction SilentlyContinue
    }
}
