Option Explicit
Dim fileSystem, shell, scriptDirectory, supervisorPath, command
If WScript.Arguments.Count <> 2 Then WScript.Quit 2
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
supervisorPath = fileSystem.BuildPath(scriptDirectory, "run-v2-paper-supervisor.cmd")
command = Chr(34) & supervisorPath & Chr(34) & " " & Chr(34) & WScript.Arguments(0) & Chr(34) & " " & Chr(34) & WScript.Arguments(1) & Chr(34)
WScript.Quit shell.Run(command, 0, True)
