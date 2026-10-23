$ErrorActionPreference = 'Stop'

$taskName = 'FlowSqueezeAlertsMonitor'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty -Path $runKey -Name 'CryptoNewsRadarLocal' -ErrorAction SilentlyContinue

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Output "Removed scheduled task: $taskName"
} else {
  Write-Output "Scheduled task is not installed: $taskName"
}

Write-Output 'Removed legacy Startup entry: CryptoNewsRadarLocal'
