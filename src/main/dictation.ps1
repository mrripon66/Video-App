param([switch]$Check)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
try {
    Add-Type -AssemblyName System.Speech
    $recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
    if ($recognizers.Count -eq 0) { throw 'No Windows speech recognition language is installed. Install a speech language in Windows Settings, or type your prompt.' }
    if ($Check) {
        @{ available = $true; language = $recognizers[0].Culture.Name } | ConvertTo-Json -Compress
        exit 0
    }
    $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizers[0])
    try {
        $grammar = New-Object System.Speech.Recognition.DictationGrammar
        $recognizer.LoadGrammar($grammar)
        $recognizer.SetInputToDefaultAudioDevice()
        $recognizer.InitialSilenceTimeout = [TimeSpan]::FromSeconds(8)
        $recognizer.BabbleTimeout = [TimeSpan]::FromSeconds(15)
        $result = $recognizer.Recognize([TimeSpan]::FromSeconds(20))
        if ($null -eq $result -or [string]::IsNullOrWhiteSpace($result.Text)) { throw 'No speech was recognized. Check your microphone and try again.' }
        @{ text = $result.Text; language = $recognizers[0].Culture.Name } | ConvertTo-Json -Compress
    } finally { $recognizer.Dispose() }
} catch {
    @{ error = $_.Exception.Message; available = $false } | ConvertTo-Json -Compress
    exit 1
}
