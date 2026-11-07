# AI Video Studio

A free-only Windows desktop studio with a chat-style prompt workspace, voice input, a persistent 500-prompt queue and a local video library. Video generation uses anonymous, quota-limited Hugging Face GPU services. Your Windows PC handles narration, sound, voice transcription, downloads and assembly.

Use the **15–20 second LTX film** option to join two newly generated shots. LTX 2.3 single clips and AnimateDiff short animations are also available. Version 1.3 adds vertical Reel export with locally generated stereo ambience. Wan, CogVideoX and Hunyuan show their availability in Settings. Video generation uses anonymous free GPU access.

## Install and use

Download the Windows x64 installer from [GitHub Releases](https://github.com/mrripon66/Video-App/releases). Install for your Windows account and open **AI Video Studio** from Start. The installer includes the desktop runtime, voice recognition and video tools. Windows may show an unknown-publisher warning because the installer is unsigned.

1. In **Create**, type your prompt and choose a video option. **Voice prompt** records your voice and turns it into editable text locally.
2. Click **Generate** to start directly. There is no review or approval popup. For the two-shot option, include a duration such as `18-second`, or use its 15-second default.
3. **Batch queue** accepts a UTF-8 `.txt` file with one prompt per nonempty line, up to 500 active prompts. **Generate batch** works through the newly added prompts in order.
4. Shared queues, service downtime and daily free GPU quotas can pause work. Only work started by your click is submitted; unrelated pending prompts stay paused.
5. Completed videos appear in **Library**, where you can play, export or reveal the local files.

An explicitly started automatic batch is saved across restarts and waits for confirmed quota refusals to reset. Pause stops the batch schedule. Saved remote handles are used for monitoring, and ambiguous requests are held for review. Free GPU availability determines throughput.

## One prompt with narration and sound

Use the 15–20 second film option. Describe the scene, then add optional instructions on separate lines.

```text
Create a 15-second quiet story about tea on a rainy morning.
Narration: auto
Voice: warm
Sound: Rain tapping the window and a quiet room in the background
Format: reel
```

For a batch, place one complete prompt on each line and separate its instructions with ` | `. Use `Narration:` followed by exact words for a script you wrote, and `Voice: clear` for the other English voice. `Format: crop` fills the vertical frame and `Format: original` keeps the source framing. Audio prepares locally before submitting a shot, so a script that exceeds the video length is caught first.

The included KittenTTS Mini engine reads English offline. `Narration: auto` uses the local `qwen3.5:4b` model in Ollama. Described effects and ambience use the optional Stable Audio 3 Small SFX CPU add-on. Preset rain, ocean, and room sounds are available from the app itself. See [sound setup and license](third-party/PROMPT-SOUND-NOTICE.md). Powered by Stability AI.

Choose **Watch** on a completed video to play, replay, and control sound in the studio. Saved Reels also appear in **Video library**.

## Make a Reel

Click **Make Reel** on a completed video. Choose a full-screen center crop or fit the whole shot, then select **Gentle rain**, **Ocean surf**, **Quiet room**, or **Original sound only**. The app saves a separate 1080 × 1920 MP4 with H.264 video and stereo AAC when audio is present. The three ambience presets are synthesized on your PC and use zero GPU generation allowance.

## Video options

| Option | Output and duration | Status |
| --- | --- | --- |
| LTX 2.3 — 15–20 second film | Two generated shots: 10 seconds plus the remainder; default total 15 seconds. Native 768 × 512, joined at 24 fps without audio. | A real anonymous 15-second film completed, decoded, played and sought successfully in the studio. Twenty-second assembly passed with local test fixtures; a fresh 20-second GPU film has not been tested. |
| LTX 2.3 — Free | One 1536 × 1024 clip; 1–10 seconds in 0.1-second steps; default 3 seconds. | Real anonymous three-second output downloaded, decoded and played. |
| AnimateDiff Lightning — Free | epiCRealism, 8 steps; fixed 16 frames at 10 fps, about 1.6 seconds. | Real anonymous output downloaded, decoded and played in the studio. |
| Wan 2.2 Fast 5B | Community service. | Disabled: a real request failed without a usable error explanation. |
| CogVideoX | Publisher demo. | Disabled: its 240–300 second GPU reservations exceed anonymous access. |
| Hunyuan Video | Publisher-endorsed demo. | Disabled: the verified free route requires a reference image. |

The two-shot option uses a cut between separately generated shots. It does not promise seamless action or identical characters across the cut. Each shot is generated from your scene description with its own duration and shot instruction. The app checks that both clips contain enough decodable video, trims only excess length, joins them locally and decodes the finished file before marking it complete. It does not loop or slow a shorter clip to claim the requested length. Quality, motion, anatomy and prompt adherence still depend on the hosted model.

Explicit numeric durations are checked before GPU submission. For example, a `15-second` prompt needs the two-shot option; the single-clip LTX route rejects it rather than silently returning three seconds. Historical LTX 0.9.8 jobs are preserved for recovery. See [provider details](docs/PROVIDERS.md).

## Free-service limits and recovery

[Hugging Face currently documents](https://huggingface.co/docs/hub/spaces-zerogpu) two GPU minutes per day anonymously and five for a free signed-in account. This app uses anonymous access only. LTX 2.3 declares a 75-second reservation **for each shot**; AnimateDiff declares 60 seconds. The two-shot film needs two separate requests, so remaining quota may prevent its second shot from starting until a normal quota reset. Completed shots are saved and reused when you continue.

The queue can hold 500 active prompts. Daily video throughput depends on the anonymous free GPU allowance and availability. A confirmed quota refusal schedules a wait for an active automatic batch, while ambiguous provider errors require review.

Use **Retry / recover** for saved work. An acknowledged request is monitored using its saved ID; a known output can be downloaded again; local assembly can be retried using the saved clips. Continuing an unsubmitted second shot makes a new normal free GPU request. A lost acknowledgement is held as uncertain rather than automatically duplicated.

## Privacy and saved data

Clicking **Generate**, **Generate batch** or **Start queue** sends the selected prompts to the selected public Hugging Face Space. There is no second approval step. Treat those prompts as information shared with that third-party service. Provider requests omit account tokens, payment credentials and cookies. There is no application analytics service.

Voice dictation uses Windows speech or bundled Whisper locally; temporary microphone recordings are removed after transcription. Local video assembly uses the bundled media tool without network inputs.

Windows data lives in `%APPDATA%\ai-video-studio\`: the saved queue, backups and `videos\` library, including completed source shots awaiting assembly. Uninstalling preserves this folder so work survives upgrades. Back it up to keep your queue and videos. Old encrypted credentials from version 1.0 are not loaded by free-only mode.

## Development

Use Node.js 24 LTS on Windows:

```sh
npm ci
npm run setup:voice
npm run setup:media
npm run check
npm test
npm run test:desktop
npm run test:recovery
npm run test:library
npm run test:voice
npm start
npm run dist:win
```

Provider contract and queue tests inject network responses; they do not make generation requests. Desktop checks launch the real Electron application with controlled local data. The Windows build must stage both voice and media resources before packaging. See [validation notes](docs/VALIDATION.md) for observed results and pending checks rather than treating an existing installer as proof of the latest source revision.

The studio uses local HTML/CSS/JavaScript and Electron's bundled runtime. No localhost frontend or backend process is needed. No video-model weights or provider keys are bundled. Offline voice components have their own [setup and licenses](docs/VOICE.md). FFmpeg 6.1.1 is bundled as a separate local executable under GPL version 3, with its original license and build README; see the [FFmpeg notice](third-party/FFMPEG-NOTICE.md). The MIT license covers the studio's original code; third-party components retain their own licenses.

A spoken microphone test still requires the user's voice and hardware. The chat-style workspace records prompts and progress; it is not a conversational language model. No stock clips, simulated provider videos or fabricated download URLs are included.
