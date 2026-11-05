param([string]$OutputPath, [switch]$Check)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
try {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class StudioAudio {
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    public static extern int mciSendString(string command, StringBuilder result, int length, IntPtr callback);
    [DllImport("winmm.dll")]
    public static extern uint waveInGetNumDevs();
}
'@
    if ([StudioAudio]::waveInGetNumDevs() -eq 0) { throw 'No recording device is available. Connect a microphone, then try Voice prompt again.' }
    if ($Check) { @{ available = $true; devices = [StudioAudio]::waveInGetNumDevs() } | ConvertTo-Json -Compress; exit 0 }
    if ([string]::IsNullOrWhiteSpace($OutputPath)) { throw 'A temporary recording destination is required.' }
    $alias = 'studio_voice'
    function Invoke-Audio([string]$Command) {
        $code = [StudioAudio]::mciSendString($Command, $null, 0, [IntPtr]::Zero)
        if ($code -ne 0) { throw "The microphone could not be used (Windows audio error $code). Check your default recording device and microphone access." }
    }
    Invoke-Audio "open new type waveaudio alias $alias"
    try {
        Invoke-Audio "set $alias time format milliseconds"
        Invoke-Audio "set $alias format tag pcm bitspersample 16 channels 1 samplespersec 16000 bytespersec 32000 alignment 2"
        Invoke-Audio "record $alias"
        Start-Sleep -Seconds 10
        Invoke-Audio "stop $alias"
        Invoke-Audio "save $alias `"$OutputPath`""
        @{ recorded = $true } | ConvertTo-Json -Compress
    } finally { [void][StudioAudio]::mciSendString("close $alias", $null, 0, [IntPtr]::Zero) }
} catch {
    @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
