#requires -Version 5.1
<#
.SYNOPSIS
Stop the local AI Music Mentor server.

.DESCRIPTION
Only processes belonging to *this* checkout are touched. launch.ps1 starts
uvicorn with the project's own .venv\Scripts\python.exe, so the project path is
in the command line — which is what lets this tell our server on port 8000 apart
from somebody else's, and refuse to stop theirs.

.EXAMPLE
.\quit.ps1

.EXAMPLE
.\quit.ps1 -Ports 8000, 5173, 4173
#>
param(
    # The port launch.ps1 serves on, and the dev server a developer may also
    # have running.
    [int[]]$Ports = @(8000, 5173),
    # How long to wait for a stopped process to disappear before saying so.
    [int]$TimeoutSeconds = 8
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-ListenerProcess {
    param([int]$Port)

    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($null -eq $connections) { return @() }

    $results = @()
    $owners = $connections | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($owner in $owners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $owner" -ErrorAction SilentlyContinue
        if ($null -eq $process) { continue }
        $commandLine = $process.CommandLine
        $results += [PSCustomObject]@{
            Id          = $owner
            CommandLine = $commandLine
            Port        = $Port
            # Started from this checkout, and therefore ours to stop.
            Ours        = ($null -ne $commandLine) -and $commandLine.Contains($ProjectDir)
            # The same app served out of a different folder. Named rather than
            # stopped: another checkout is somebody else's session.
            OtherCopy   = ($null -ne $commandLine) -and
                          $commandLine.Contains("app.main:app") -and
                          -not $commandLine.Contains($ProjectDir)
        }
    }
    return $results
}

function Get-OurListener {
    $ours = @()
    foreach ($port in $Ports) {
        $ours += Get-ListenerProcess -Port $port | Where-Object { $_.Ours }
    }
    return $ours
}

function Show-CommandLine {
    param($Listener)
    $shown = $Listener.CommandLine
    if ($null -eq $shown) { return "(pid $($Listener.Id))" }
    if ($shown.Length -gt 72) { return $shown.Substring(0, 72) }
    return $shown
}

$stopped = 0
$skipped = 0

foreach ($port in $Ports) {
    foreach ($listener in Get-ListenerProcess -Port $port) {
        if (-not $listener.Ours) {
            # Worth saying out loud: it explains why launch.ps1 may still find
            # the port busy after this.
            $what = if ($listener.OtherCopy) {
                "an AI Music Mentor server from another folder"
            } else {
                "something else"
            }
            Write-Host "  port $port is held by $what, left alone: $(Show-CommandLine $listener)"
            $skipped++
            continue
        }

        Write-Host "  stopping $(Show-CommandLine $listener) (pid $($listener.Id))"
        # Windows has no polite signal for a console process: Stop-Process ends
        # it. -Force only skips the confirmation prompt, so there is no gentler
        # first attempt to make here.
        Stop-Process -Id $listener.Id -Force -ErrorAction SilentlyContinue
        $stopped++
    }
}

if ($stopped -eq 0) {
    if ($skipped -eq 0) {
        Write-Host "AI Music Mentor is not running."
    }
    exit 0
}

# Ending a process is not instant; wait until the port is actually free so a
# launch straight afterwards does not find it still taken.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    if (@(Get-OurListener).Count -eq 0) {
        Write-Host "Stopped."
        exit 0
    }
    Start-Sleep -Milliseconds 300
}

Write-Warning "Still holding a port after $TimeoutSeconds seconds:"
foreach ($listener in Get-OurListener) {
    Write-Warning "  pid $($listener.Id) on port $($listener.Port)"
}
exit 1
