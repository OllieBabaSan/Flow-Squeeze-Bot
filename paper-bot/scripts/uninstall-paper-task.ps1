$ErrorActionPreference = 'Stop'
$taskName = 'FlowSqueezePaperMonitor'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Write-Output "Removed scheduled task: $taskName"
