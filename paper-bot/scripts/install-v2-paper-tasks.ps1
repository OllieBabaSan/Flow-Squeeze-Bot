$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'run-v2-paper-hidden.vbs'
$command = Join-Path $env:SystemRoot 'System32\wscript.exe'
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$cohorts = @(
  @{ Task = 'FlowSqueezeV2BybitConfirmed'; Config = 'config.v2.bybit.confirmed.json'; Data = 'data-v2-bybit-confirmed' },
  @{ Task = 'FlowSqueezeV2BybitImmediate'; Config = 'config.v2.bybit.immediate.json'; Data = 'data-v2-bybit-immediate' },
  @{ Task = 'FlowSqueezeV2BinanceConfirmed'; Config = 'config.v2.binance.confirmed.json'; Data = 'data-v2-binance-confirmed' },
  @{ Task = 'FlowSqueezeV2BinanceImmediate'; Config = 'config.v2.binance.immediate.json'; Data = 'data-v2-binance-immediate' }
)
foreach ($cohort in $cohorts) {
  if (Get-ScheduledTask -TaskName $cohort.Task -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $cohort.Task -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $cohort.Task -Confirm:$false
  }
  $arguments = '//B //Nologo "{0}" "{1}" "{2}"' -f $launcher, $cohort.Config, $cohort.Data
  $action = New-ScheduledTaskAction -Execute $command -Argument $arguments -WorkingDirectory $projectDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
  $task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description ('Flow/Squeeze V2 paper cohort: {0}. No live order capability.' -f $cohort.Task)
  Register-ScheduledTask -TaskName $cohort.Task -InputObject $task -Force | Out-Null
  Start-ScheduledTask -TaskName $cohort.Task
  Write-Output "Installed and started scheduled task: $($cohort.Task)"
}
