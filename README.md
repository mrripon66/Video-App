# AI Video Studio

A Windows desktop studio for creating videos with remote GPU providers. The application runs on CPU-only PCs; models run on fal.ai. No Python, Node.js, development server, or local GPU is needed to use the installer.

## Install and use

Download `AI-Video-Studio-Setup-1.0.0-x64.exe` from the Windows build artifact on the repository's **Actions** page. Install for your Windows account and open **AI Video Studio** from the Start menu or desktop shortcut. This initial release is unsigned, so Windows may display an unknown-publisher warning.

1. Open **Settings**, enter your own fal.ai API key, and save it. Keys are encrypted with Windows credential protection and never sent to the interface.
2. In **Create**, type a prompt and choose a model. **Voice prompt** uses your default microphone and local speech recognition. The installer includes an offline Whisper model, so a Windows speech language pack is optional. Speak a short prompt, allow a moment for CPU transcription, then edit the text before adding it.
3. Add prompts to the queue. **Batch queue** also imports a UTF-8 `.txt` file, one prompt per nonempty line, with up to 400 active prompts.
4. Review the queue and approve the exact pending batch before starting. fal.ai charges your provider account according to its current pricing. The app does not invent estimates or purchase credits.
5. Completed videos are downloaded to your local **Library**. Play, export, or reveal their files.

The queue starts paused at every launch. Pause prevents new submissions while an already submitted request may continue at the provider. A cancellation request does not guarantee a refund. Uncertain submissions are held for review instead of being automatically sent again. Use **Retry / recover** to monitor a saved request or download its result without generating another video.

## Models and scope

Wan 2.1, LTX 2.3 Fast, CogVideoX-5B, Hunyuan Video, and AnimateDiff use documented fal queue APIs. See [provider documentation](docs/PROVIDERS.md) for exact endpoints, default settings, and source links. Availability in the catalog means a documented integration exists; account access and generation remain subject to the provider.

The chat-style workspace records your prompts and generation progress. It does not claim to be a conversational language model. No stock clips, simulated videos, or fabricated download URLs are included.

## Privacy and saved data

Prompts are sent to fal.ai only after queue approval. Voice dictation runs locally using Windows speech or bundled Whisper. Temporary microphone recordings are removed after transcription. There is no application analytics service. API traffic remains in the main process; the interface is isolated and cannot read the key. Downloaded output is limited to documented fal media hosts and screened MP4/WebM containers.

Windows data lives in `%APPDATA%\ai-video-studio\`: `studio.json`, a backup, `credentials.bin`, and `videos\`. Uninstalling keeps this folder so your queue and library survive upgrades. Back up this folder to preserve your work; encrypted keys are tied to your Windows account. Do not commit it to source control.

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

Tests use temporary local data and mocked provider responses. They never submit real video generation requests or spend credits. Desktop tests launch the actual Electron application and verify offline interactions, persistence, and the payment approval boundary. GitHub Actions runs the same checks on Windows and uploads a complete NSIS installer with a SHA-256 checksum.

The application uses Electron's bundled runtime and local HTML/CSS/JavaScript. There is no localhost frontend or backend process to start. The build downloads pinned, checksum-verified offline voice components; the installer includes them. See [voice setup and licenses](docs/VOICE.md). No signing certificate or provider key is embedded in the source, build, or installer.

## Verification limits

An actual paid generation and a spoken microphone transcription require the account holder's approval and hardware. Neither is represented as tested by offline contract tests. Provider/API changes can make a model unavailable; errors remain visible in the queue. See [validation notes](docs/VALIDATION.md) for this build's actual checks.
