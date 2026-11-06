# Free remote video generation

Verified on **November 5, 2026**. Version 1.1 uses one anonymous, quota-limited public Hugging Face Space. The Windows app requires no provider key, paid account or card for this integration. It sends no authentication headers or cookies, so a user's paid Hugging Face balance cannot be charged through the adapter. Paid video providers are disabled.

## Available model

**LTX Video 0.9.8 distilled** runs in the model publisher's public [Lightricks/ltx-video-distilled Space](https://huggingface.co/spaces/Lightricks/ltx-video-distilled). Read-only checks returned `RUNNING`, ZeroGPU hardware, and HTTP 200 for its public API metadata. This is the 0.9.8 distilled model identified by [the Space source](https://huggingface.co/spaces/Lightricks/ltx-video-distilled/blob/8a42e93469c66b62d794b83a4233f5fc8439e2b5/app.py), not LTX 2.3.

The app requests a two-second, 512-pixel-high by 704-pixel-wide text-to-video clip, with texture upscaling disabled. The Space runs the model on a remote GPU. The PC does not download video-model weights or perform GPU inference.

Wan, CogVideoX, Hunyuan and AnimateDiff remain visible as unavailable because this release has no verified free prompt-only API for them. Previous paid-provider catalog entries are disabled, including the former LTX paid endpoint. Older jobs are retained; they cannot silently switch to a paid provider. The original Wan publisher's Space reported `RUNTIME_ERROR` during verification. A community Wan Space was running but required an input image and therefore did not match this app's prompt-only workflow.

## Free quota and availability

Hugging Face's [ZeroGPU documentation](https://huggingface.co/docs/hub/spaces-zerogpu) currently lists two minutes of daily included GPU quota for anonymous use and five minutes for a free signed-in account. This app deliberately uses anonymous access only. Anonymous usage is shared and has lower queue priority. The chosen Space requests an `xlarge` GPU, which consumes quota at twice the normal rate, and declares a 60-second maximum GPU task for the app's short clip settings. Actual quota availability and throughput vary. Do not expect 400 clips per day or unlimited generation.

PRO, Team and Enterprise accounts can automatically consume prepaid credits after their included quota. The adapter accepts no token or custom authentication, so this paid extension is unavailable in the app. It never rotates identities, changes IP addresses, switches accounts, or calls an alternate endpoint to evade quotas.

A 400-prompt queue stores work on the PC. It does not reserve 400 free GPU jobs. On quota exhaustion or a provider error, processing stops and the remaining prompts stay saved. Wait for the provider's reset or restored availability before reviewing and resuming. Spaces may sleep, queue requests, change their API, or become unavailable.

## Verified API contract

Hugging Face documents the [two-step Gradio HTTP API](https://huggingface.co/docs/hub/spaces-api-endpoints). The adapter first checks the live schema at:

```text
GET https://lightricks-ltx-video-distilled.hf.space/gradio_api/info
```

The `/text_to_video` endpoint must retain the following ordered inputs and a Video output:

```text
prompt, negative_prompt, input_image_filepath, input_video_filepath,
height_ui, width_ui, mode, duration_ui, ui_frames_to_use, seed_ui,
randomize_seed, ui_guidance_scale, improve_texture_flag
```

The app submits this positional body, replacing only the user's prompt:

```json
{"data":["USER PROMPT","worst quality, inconsistent motion, blurry, jittery, distorted",null,null,512,704,"text-to-video",2,9,42,true,1,false]}
```

Submission uses `POST /gradio_api/call/text_to_video`. Its actual `event_id` becomes the saved request reference. Monitoring reads `GET /gradio_api/call/text_to_video/{event_id}` as server-sent events. Heartbeats do not trigger new submissions. A complete response must contain an actual VideoData result with `data[0].video.url`; the adapter does not invent a media address. This schema was checked anonymously through `/gradio_api/info` and `/gradio_api/openapi.json` without running inference.

Only the exact verified Space origin is accepted. API redirects, credentials, custom endpoints and headers are rejected. Video addresses must use that same origin's `/gradio_api/file=/tmp/gradio/` endpoint. The event stream has time, message-size and total-size bounds. Changed schemas, malformed results, interrupted streams and quota errors stop safely. An unknown submission outcome is never automatically retried.

There is no verified cancellation endpoint in this integration. Cancellation therefore reports that it is unconfirmed; a remote job may continue using free quota. Gradio's simplified event stream is consumed as it is read, rather than durable replay storage, and saved request references may also expire when the Space restarts. Keep the studio open while generating. The app saves the actual output URL before downloading so interrupted downloads can recover from that URL without polling a consumed completion or submitting a replacement.

## Validation and maintenance

Fourteen mocked provider tests pass, including fragmented CRLF event streams, missing results, malformed schemas, strict addresses, no authentication, quota stops, timeouts, and unsupported cancellation. An actual anonymous free generation, corrected MP4 download, production desktop download recovery, and decoded playback/seeking also passed; see [VALIDATION.md](VALIDATION.md). No paid video request or purchase was made.

Keep `src/core/free-provider.js` restricted to verified free endpoints. Add a model only after checking its actual API, quota behavior and returned media. A documented model name is not evidence of a usable free hosted service. Preserve the app's free-only boundary when updating dependencies or provider configuration.
