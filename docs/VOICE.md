# Voice prompts

The microphone button turns speech into editable prompt text. Review that text before adding a video to the queue. Voice recognition does not submit a video request or use provider credits.

The app first checks Windows' installed speech recognizers. If no speech language is installed, it uses the included **Whisper tiny multilingual** model locally on the CPU. The fallback records a 10-second WAV clip through the Windows audio device, then transcribes it on the PC. It does not send the recording to a service. Temporary audio and transcript files are removed after the attempt. The microphone must be connected and enabled in Windows privacy settings.

Whisper tiny is deliberately small enough for this CPU-only application. It supports multilingual recognition and automatically detects the language. Accuracy varies with language, accent, microphone and background noise. The text remains editable. This is prompt dictation, not an open-ended conversational voice assistant. Its CPU processing is separate from video generation, which still requires a configured remote provider.

## Reproducible build assets

Run `npm run setup:voice` after `npm ci` on Windows x64. The script downloads only public, free software/model files, verifies SHA-256 and exact byte counts, and assembles `resources/voice/`. It requires no administrator rights and installs nothing into Windows. `resources/voice/` and `.voice-cache/` are generated files excluded from Git; the installer includes the prepared voice directory through `extraResources`.

| Component | Pinned source | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| whisper.cpp CPU x64 | [Build b5454](https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip), matching [v1.9.5](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5) | 8,928,640 | `6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb` |
| Whisper tiny multilingual | [Official converted weights, pinned revision](https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin) | 77,691,713 | `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21` |
| Microsoft VC runtime source package | [Official 14.51.36247 x64 redistributable](https://download.visualstudio.microsoft.com/download/pr/ebdab8e5-1d7b-4d9f-a11b-cbb1720c3b12/843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C/VC_redist.x64.exe) | 18,731,856 | `843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c` |

The semantic v1.9.5 release has no executable attachments; its release notes identify b5454 as the matching binary build. The script copies `whisper-cli.exe`, its whisper/ggml DLLs and CPU backends into `resources/voice/bin/`. It extracts the required unmodified x64 Microsoft runtime DLLs from the verified redistributable cabinet into the same folder. The redistributable installer is never executed. This avoids a separate runtime installation on a clean Windows PC. Updating locally deployed runtime DLLs requires rebuilding the application; see [Microsoft's deployment guidance](https://learn.microsoft.com/en-us/cpp/windows/deployment-in-visual-cpp).

`resources/voice/voice.json` records the installed engine and model. The app resolves these paths:

```text
resources/voice/bin/whisper-cli.exe
resources/voice/ggml-tiny.bin
```

The [official CLI documentation](https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/examples/cli/README.md) defines the invocation used by the application:

```text
whisper-cli.exe -m ggml-tiny.bin -f prompt.wav -l auto -ng -t 4 -otxt -of transcript -nt -np
```

`-ng` forces CPU operation. WAV capture uses 16 kHz, mono, 16-bit PCM through Windows' built-in waveform audio interface. The capture sequence follows [Microsoft's waveform recording example](https://learn.microsoft.com/en-us/windows/win32/multimedia/opening-a-device) and [supported audio-format settings](https://learn.microsoft.com/en-us/windows/win32/multimedia/set).

## Validation

Run `npm run test:voice`. The test fetches the official repository's [small JFK speech sample](https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/samples/jfk.wav), checks its SHA-256, and runs the bundled engine with the application's CPU arguments. Once this fixture is cached, the inference test needs no network. It does not access the microphone. It asserts that key speech phrases are recognized and writes `test-results/voice/voice-report.json`.

On November 5, 2026, the bundled runtime and multilingual tiny model transcribed that fixture successfully on the Windows execution host in about **1 second**, using four CPU threads. This verifies real local model inference and executable dependencies. It does not verify the user's microphone, privacy settings, or recognition quality for every language.

## Licenses

whisper.cpp and the Whisper model are MIT licensed. Full notices are retained in `third-party/whisper.cpp-LICENSE.txt` and `third-party/whisper-model-LICENSE.txt` and copied into `resources/voice/licenses/`. Microsoft's DLLs have separate terms; see `third-party/MICROSOFT-VC-RUNTIME-NOTICE.md`. The project's MIT license does not replace third-party licenses.
