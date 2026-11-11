' PoxScore — lanza launcher.mjs con Node SIN ventana de consola (queda en la bandeja)
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)

On Error Resume Next
sh.Run "node launcher.mjs", 0, False
If Err.Number <> 0 Then
  MsgBox "No se encontro Node.js en el PATH." & vbCrLf & "Instala Node.js o ejecuta launcher\launcher.mjs manualmente.", 16, "PoxScore"
End If
