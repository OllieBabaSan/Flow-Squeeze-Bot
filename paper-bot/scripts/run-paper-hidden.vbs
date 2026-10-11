Option Explicit
Dim fileSystem, shell, scriptDirectory, supervisorPath
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
supervisorPath = fileSystem.BuildPath(scriptDirectory, "run-paper-supervisor.cmd")
WScript.Quit shell.Run(Chr(34) & supervisorPath & Chr(34), 0, True)
