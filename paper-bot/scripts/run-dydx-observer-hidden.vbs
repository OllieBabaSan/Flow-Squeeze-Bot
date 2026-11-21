Option Explicit
Dim shell, fileSystem, scriptDirectory, supervisorPath
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
supervisorPath = fileSystem.BuildPath(scriptDirectory, "run-dydx-observer-supervisor.cmd")
shell.Run Chr(34) & supervisorPath & Chr(34), 0, False
