$ErrorActionPreference = 'Stop'

$taskName = 'FlowSqueezeAlertsMonitor'
$projectDir = Split-Path -Parent $PSScriptRoot
$hiddenLauncherPath = Join-Path $PSScriptRoot 'run-alertsbot-hidden.vbs'
$commandPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

# Remove the retired Run-key launcher before registering the one supported
# startup mechanism. Leaving both enabled can create competing monitor trees.
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty -Path $runKey -Name 'CryptoNewsRadarLocal' -ErrorAction SilentlyContinue

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

# Remove only processes whose command line points at this monitor. This clears
# an orphan left by the retired Startup mechanism before the one task starts.
$projectPattern = [regex]::Escape($projectDir)
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -in @('node.exe', 'cmd.exe', 'wscript.exe') -and
    $_.CommandLine -match $projectPattern -and
    $_.CommandLine -match 'local-radar|run-alertsbot'
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$action = New-ScheduledTaskAction `
  -Execute $commandPath `
  -Argument ('//B //Nologo "{0}"' -f $hiddenLauncherPath) `
  -WorkingDirectory $projectDir

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -Hidden

$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $logonTrigger -Settings $settings -Principal $principal `
  -Description 'Standalone Flow/Squeeze market-alert monitor. Starts at Windows sign-in and restarts after failure.'

Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Output "Installed and started scheduled task: $taskName"
Write-Output "Hidden launcher: $hiddenLauncherPath"
