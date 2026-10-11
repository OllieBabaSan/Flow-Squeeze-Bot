Option Explicit

Dim fileSystem, shell, scriptDirectory, supervisorPath, command

Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
If WScript.Arguments.Count > 0 Then
  supervisorPath = WScript.Arguments(0)
Else
  supervisorPath = fileSystem.BuildPath(scriptDirectory, "run-alertsbot-supervisor.cmd")
End If
command = Chr(34) & supervisorPath & Chr(34)

' Window style 0 keeps the command supervisor and its Node child invisible.
' Waiting preserves one durable task process for Task Scheduler to supervise.
WScript.Quit shell.Run(command, 0, True)
