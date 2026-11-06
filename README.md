# AI Video Studio

A free-only Windows desktop studio for quota-limited remote AI video generation. Version 1.1 uses the official Lightricks LTX Video 0.9.8 distilled Space on Hugging Face ZeroGPU anonymously. No API key, payment card, paid account, local GPU, Python, Node.js, or development server is needed to use the installer. Paid providers are disabled.

## Install and use

Download `AI-Video-Studio-Setup-1.1.0-x64.exe` from the release or Windows build artifact on the repository's **Actions** page. Install for your Windows account and open **AI Video Studio** from the Start menu or desktop shortcut. This release is unsigned, so Windows may display an unknown-publisher warning.

1. Open the app. The free provider is configured automatically; no account key setup is required.
2. In **Create**, type a prompt and choose a model. **Voice prompt** uses your default microphone and local speech recognition. The installer includes an offline Whisper model, so a Windows speech language pack is optional. Speak a short prompt, allow a moment for CPU transcription, then edit the text before adding it.
3. Add prompts to the queue. **Batch queue** also imports a UTF-8 `.txt` file, one prompt per nonempty line, with up to 400 active prompts.
4. Review the exact prompts and start the free queue. Approved prompts are sent to the public Lightricks Space. Waiting queues, downtime, and daily GPU quotas can stop a batch; the app never switches to a paid service.
5. Completed videos are downloaded to your local **Library**. Play, export, or reveal their files.

The queue starts paused at every launch. Pause prevents new submissions while an already submitted request may continue using your free quota. The public service does not expose reliable cancellation through this API. Uncertain submissions are held for review instead of being sent again automatically. Use **Retry / recover** to monitor a saved request or download its result without generating another video.

## Free-service limits

Hugging Face currently documents 2 GPU minutes per day for anonymous use and 5 for a free account, with shared queues. This application uses anonymous access only, without tokens or automatic paid overages. The selected Space uses an xlarge GPU, which consumes quota at twice the standard rate. A short clip may use most of the available quota. The app stores 400 active prompts; that is saved queue capacity, not a promise of 400 free generations per day. It stops on quota errors instead of bypassing limits, retrying endlessly, or charging you. [Official quota documentation](https://huggingface.co/docs/hub/spaces-zerogpu).

## Models and scope

LTX Video 0.9.8 distilled is the verified free prompt-to-video integration. Wan, LTX 2.3, CogVideoX, Hunyuan and AnimateDiff remain visible as unavailable because no free API is configured for them. The previous paid fal integrations cannot be selected or invoked through this release. See [provider documentation](docs/PROVIDERS.md) for the exact Space, settings, quota limits and verification evidence.

The chat-style workspace records your prompts and generation progress. It does not claim to be a conversational language model. No stock clips, simulated videos, or fabricated download URLs are included.

## Privacy and saved data

Prompts are sent to the public Hugging Face Space only after queue approval. Voice dictation runs locally using Windows speech or bundled Whisper. Temporary microphone recordings are removed after transcription. There is no application analytics service. Provider requests contain no account token or payment credentials. Downloads are restricted to reviewed hosts and screened MP4/WebM containers. Treat prompts sent to the public demo as information shared with that third-party service.

Windows data lives in `%APPDATA%\ai-video-studio\`: `studio.json`, a backup, and `videos\`. Old encrypted credentials from version 1.0, if any, are not loaded or used by free-only mode. Uninstalling keeps the folder so your queue and library survive upgrades. Back up this folder to preserve your work; do not commit it to source control.

## Development

Use Node.js 24 LTS on Windows. From this repository:

```sh
npm ci
npm run setup:voice
npm run check
npm test
npm run test:desktop
npm run test:recovery
npm run test:library
npm run test:voice
npm start
npm run dist:win
```

Automated tests use temporary local data and mocked provider responses. They never submit real generation requests. Desktop tests launch the actual Electron application and verify free-only provider selection, paid-key rejection, batch approval, persistence, and playback. GitHub Actions runs these checks on Windows and uploads a complete NSIS installer with a SHA-256 checksum.

The application uses Electron's bundled runtime and local HTML/CSS/JavaScript. There is no localhost frontend or backend process to start. The build downloads pinned, checksum-verified offline voice components; the installer includes them. See [voice setup and licenses](docs/VOICE.md). No signing certificate or provider key is embedded in the source, build, or installer.

## Verification limits

A spoken microphone test still requires the user's voice and hardware. Free GPU availability can change or a daily quota can be exhausted; the app reports those errors rather than inventing an output. See [validation notes](docs/VALIDATION.md) for observed checks and any live free-generation result.
