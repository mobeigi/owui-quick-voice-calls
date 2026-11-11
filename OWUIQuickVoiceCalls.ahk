#Requires AutoHotkey v2.0
#SingleInstance Ignore
#MaxThreadsPerHotkey 1

if A_Args.Length && A_Args[1] = "--check"
    ExitApp()

SetWorkingDir(A_ScriptDir)
global BridgeFile := EnvGet("LOCALAPPDATA") "\owui-quick-voice-calls\runtime\bridge.ini"
if A_Args.Length >= 2 && A_Args[1] = "--bridge"
    BridgeFile := A_Args[2]
try {
    global HotkeyName := IniRead(BridgeFile, "bridge", "hotkey")
    global TriggerKey := RegExReplace(HotkeyName, "^[!^+#<>]+")
    global RequireUIAccess := IniRead(BridgeFile, "bridge", "uiAccess") = "1"
    global StatusPollMs := Integer(IniRead(BridgeFile, "bridge", "statusPollMs"))
    global SoundsEnabled := IniRead(BridgeFile, "bridge", "sounds") = "1"
    global ErrorBeeps := IniRead(BridgeFile, "bridge", "errorBeep") = "1"
    global ConnectedSound := IniRead(BridgeFile, "bridge", "connectedSound")
    global HangupSound := IniRead(BridgeFile, "bridge", "hangupSound")
} catch {
    MsgBox("Cannot read controller settings. Start the helper with Launch.cmd, not this script directly.", "Open WebUI Quick Voice Calls")
    ExitApp()
}
global UIAccessEnabled := HasUIAccess()
if A_IsAdmin {
    MsgBox("Do not run Open WebUI Quick Voice Calls as administrator. Use Launch.cmd as your normal Windows user; UIAccess handles elevated windows.", "Open WebUI Quick Voice Calls")
    ExitApp()
}
if RequireUIAccess && !UIAccessEnabled {
    MsgBox("UIAccess did not activate. Install the signed AutoHotkey v2 UIAccess runtime in Program Files and start with Launch.cmd. Alternatively choose hotkeyMode: standard in your config (elevated-window support is then not guaranteed).", "Open WebUI Quick Voice Calls")
    ExitApp()
}
try {
    ; Simple keys use RegisterHotKey; the UIAccess keyboard hook tracks release
    ; over elevated windows without elevating the controller or browser.
    Hotkey(HotkeyName, ToggleCall, "T1")
    InstallKeybdHook()
} catch as err {
    MsgBox("Cannot register configured hotkey " HotkeyName ". Check the AHK key name or other applications using it.", "Open WebUI Quick Voice Calls")
    ExitApp()
}
Persistent()
global LastState := ""
global LastGeneration := ""
global LastStarted := ""
global LastEnded := ""
global Exiting := false
global Failures := 0

A_TrayMenu.Delete()
A_TrayMenu.Add("Start/End Call", (*) => SendAction("toggle"))
A_TrayMenu.Add("Setup (Login)", (*) => SendAction("login"))
A_TrayMenu.Add("Exit", (*) => ExitApp())
A_IconTip := "Open WebUI Quick Voice Calls - " HotkeyName " starts / ends call"
OnExit(Cleanup)

SetTimer(PollStatus, StatusPollMs)
PollStatus()

; KeyWait prevents holding the configured key from repeatedly toggling calls.
ToggleCall(*) {
    SendAction("toggle")
    KeyWait(TriggerKey)
}

HasUIAccess() {
    token := 0
    if !DllCall("advapi32\OpenProcessToken", "Ptr", DllCall("GetCurrentProcess", "Ptr"), "UInt", 0x0008, "Ptr*", &token)
        return false
    try {
        info := Buffer(4, 0)
        needed := 0
        return DllCall("advapi32\GetTokenInformation", "Ptr", token, "Int", 26, "Ptr", info, "UInt", 4, "UInt*", &needed) && NumGet(info, 0, "UInt") != 0
    } finally DllCall("CloseHandle", "Ptr", token)
}

Request(action) {
    port := IniRead(BridgeFile, "bridge", "port")
    token := IniRead(BridgeFile, "bridge", "token")
    if !RegExMatch(port, "^\d+$") || !RegExMatch(token, "^[a-f0-9]{64}$")
        throw Error("Invalid controller credentials")
    req := ComObject("WinHttp.WinHttpRequest.5.1")
    req.SetProxy(1) ; Never send local controller credentials through a proxy.
    req.SetTimeouts(300, 300, 500, 1000)
    req.Open("POST", "http://127.0.0.1:" port "/" action, false)
    req.SetRequestHeader("Authorization", "Bearer " token)
    req.SetRequestHeader("X-OWUI-Quick-Voice-Calls-UIAccess", UIAccessEnabled ? "1" : "0")
    req.Send()
    if req.Status >= 300
        throw Error(req.ResponseText)
    return req.ResponseText
}

SendAction(action) {
    try {
        Request(action)
        PollStatus()
    } catch as err {
        TrayTip("Controller unavailable or busy. " err.Message, "Open WebUI Quick Voice Calls")
        PlayErrorSound(100)
    }
}

PollStatus() {
    global LastState, LastGeneration, Failures, LastStarted, LastEnded
    if Exiting
        return
    try {
        text := Request("heartbeat")
        Failures := 0
        RegExMatch(text, "m)^state=([^\r\n]+)", &stateMatch)
        RegExMatch(text, "m)^message=([^\r\n]+)", &messageMatch)
        RegExMatch(text, "m)^generation=(\d+)", &generationMatch)
        RegExMatch(text, "m)^started=(\d+)", &startedMatch)
        RegExMatch(text, "m)^ended=(\d+)", &endedMatch)
        state := stateMatch[1]
        message := messageMatch[1]
        generation := generationMatch[1]
        started := startedMatch[1]
        ended := endedMatch[1]
        ; Counters survive brief idle -> warming transitions between status polls.
        if LastStarted != "" && started > LastStarted
            PlayCallSound("connected")
        if LastEnded != "" && ended > LastEnded
            PlayCallSound("hangup")
        LastStarted := started
        LastEnded := ended
        if state != LastState || generation != LastGeneration {
            if state = "error" {
                PlayErrorSound(180)
                TrayTip(message, "Open WebUI Quick Voice Calls")
            }
            LastState := state
            LastGeneration := generation
        }
        A_IconTip := "Open WebUI Quick Voice Calls - " message
    } catch {
        Failures += 1
        warningAt := Ceil(9000 / StatusPollMs)
        A_IconTip := Failures < warningAt ? "Open WebUI Quick Voice Calls - connecting" : "Open WebUI Quick Voice Calls - offline"
        if Failures = warningAt {
            PlayErrorSound(180)
            TrayTip("Controller is offline. If the dedicated browser remains open, close it to release the microphone.", "Open WebUI Quick Voice Calls")
        }
    }
}

PlayCallSound(name) {
    if !SoundsEnabled
        return
    ; Local WAV playback continues without blocking the hotkey/status thread.
    ; A missing/unplayable asset must not turn a successful call into an error.
    try SoundPlay(name = "connected" ? ConnectedSound : HangupSound, false)
    catch
        SoundBeep(name = "connected" ? 1100 : 650, 100)
}

PlayErrorSound(duration) {
    if SoundsEnabled && ErrorBeeps
        SoundBeep(350, duration)
}

Cleanup(*) {
    global Exiting := true
    SetTimer(PollStatus, 0)
    try Request("shutdown")
    ; The controller also ends the call if heartbeat is lost for 12 seconds.
}
