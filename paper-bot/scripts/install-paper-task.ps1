$ErrorActionPreference = 'Stop'
$taskName = 'FlowSqueezePaperMonitor'
$projectDir = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'run-paper-hidden.vbs'
$command = Join-Path $env:SystemRoot 'System32\wscript.exe'
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
$pattern = [regex]::Escape($projectDir)
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $pattern -and $_.CommandLine -match 'run-paper' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$action = New-ScheduledTaskAction -Execute $command -Argument ('//B //Nologo "{0}"' -f $launcher) -WorkingDirectory $projectDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Flow/Squeeze Hyperliquid paper-trading monitor. No live order capability.'
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Installed and started scheduled task: $taskName"
