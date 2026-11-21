$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId

function Install-MonitorTask($name, $launcher, $arguments, $description) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
  }
  $actionArgs = '//B //Nologo "{0}"{1}' -f $launcher, $arguments
  $action = New-ScheduledTaskAction -Execute $wscript -Argument $actionArgs -WorkingDirectory $projectDir
  $task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description
  Register-ScheduledTask -TaskName $name -InputObject $task -Force | Out-Null
  Start-ScheduledTask -TaskName $name
  Write-Output "Installed and started scheduled task: $name"
}

$cacheLauncher = Join-Path $PSScriptRoot 'run-shared-hyperliquid-cache-hidden.vbs'
Install-MonitorTask 'FlowSqueezeV2RSharedMarketCache' $cacheLauncher '' 'Shared read-only Hyperliquid market cache for Flow/Squeeze V2R paper cohorts.'
Start-Sleep -Seconds 5

$paperLauncher = Join-Path $PSScriptRoot 'run-v2-paper-hidden.vbs'
$cohorts = @(
  @{ Task = 'FlowSqueezeV2RBybitConfirmed'; Config = 'config.v2r.bybit.confirmed.json'; Data = 'data-v2r-bybit-confirmed' },
  @{ Task = 'FlowSqueezeV2RBybitImmediate'; Config = 'config.v2r.bybit.immediate.json'; Data = 'data-v2r-bybit-immediate' },
  @{ Task = 'FlowSqueezeV2RBinanceConfirmed'; Config = 'config.v2r.binance.confirmed.json'; Data = 'data-v2r-binance-confirmed' },
  @{ Task = 'FlowSqueezeV2RBinanceImmediate'; Config = 'config.v2r.binance.immediate.json'; Data = 'data-v2r-binance-immediate' }
)
foreach ($cohort in $cohorts) {
  $args = ' "{0}" "{1}"' -f $cohort.Config, $cohort.Data
  Install-MonitorTask $cohort.Task $paperLauncher $args ('Flow/Squeeze repaired V2 paper cohort: {0}. No live order capability.' -f $cohort.Task)
}
