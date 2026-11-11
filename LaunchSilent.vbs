Option Explicit

Const MinimumNodeMajor = 24
Const AppName = "Open WebUI Quick Voice Calls"

Dim shell, files, root, exitCode, checkOnly
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
checkOnly = False
If WScript.Arguments.Count > 0 Then checkOnly = (WScript.Arguments(0) = "--check")

If RunHidden("node.exe -e " & Quote("process.exit(Number(process.versions.node.split('.')[0]) >= " & MinimumNodeMajor & " ? 0 : 1)")) <> 0 Then
    Fail "Node.js 24+ must be available on PATH. Install or select a supported Node.js version, then launch again."
End If

If Not files.FileExists(files.BuildPath(root, "node_modules\playwright\package.json")) Then
    Fail "Dependencies are missing. Run npm install in the project directory, then launch again."
End If

' Validate prerequisites without starting a controller/browser (for local checks).
If checkOnly Then WScript.Quit 0

' Run with window style 0. Waiting keeps exit-code/error handling out of a console;
' src/launch.js exits after the detached controller and AHK helper are running.
exitCode = RunHidden("node.exe " & Quote(files.BuildPath(root, "src\launch.js")))
If exitCode <> 0 Then
    Fail "Startup failed. Run Launch.cmd or npm run launch from a Node.js 24+ terminal to see the error details."
End If

WScript.Quit 0

Function RunHidden(command)
    On Error Resume Next
    RunHidden = shell.Run(command, 0, True)
    If Err.Number <> 0 Then
        RunHidden = 1
        Err.Clear
    End If
    On Error GoTo 0
End Function

Function Quote(value)
    Quote = Chr(34) & value & Chr(34)
End Function

Sub Fail(message)
    If Not checkOnly Then MsgBox message, vbExclamation, AppName
    WScript.Quit 1
End Sub
