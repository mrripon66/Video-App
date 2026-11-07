# Free video providers

Current version 1.2 integration record, updated November 6, 2026. Read-only metadata and source checks establish API contracts; the live results below distinguish a real completed request from a merely reachable endpoint. The app uses anonymous Hugging Face Spaces access without keys, tokens or cookies. Paid providers and automatic paid fallbacks are disabled.

## Enabled options

| Choice | Service | Output and limits | Declared GPU allocation |
| --- | --- | --- | --- |
| **LTX 2.3 — 15–20 second film** | Two sequential requests to publisher [Lightricks/LTX-2-3](https://huggingface.co/spaces/Lightricks/LTX-2-3), followed by local assembly | Default 15 seconds; accepts 15–20 seconds in 0.1-second increments. First shot 10 seconds, second shot the remainder. Native 768 × 512, silent joined output at 24 fps. | 75 seconds per shot; two requests, subject to remaining shared quota. |
| **LTX 2.3 — Free** | Same publisher Space | Default 3 seconds, 1536 × 1024; accepts 1–10 seconds in 0.1-second increments. | 75 seconds, standard allocation. |
| **AnimateDiff Lightning — Free** | Publisher [ByteDance/AnimateDiff-Lightning](https://huggingface.co/spaces/ByteDance/AnimateDiff-Lightning) | epiCRealism base, 8 steps; fixed 16 frames at 10 fps, about 1.6 seconds. | Default 60 seconds, standard allocation. |

The old [Lightricks/ltx-video-distilled](https://huggingface.co/spaces/Lightricks/ltx-video-distilled) two-second 704 × 512 profile remains for historical jobs. It uses xlarge with a 60-second reservation and double quota multiplier. It is hidden from the normal new-job catalog.

The longer film is an app composition workflow, not a claim that the public LTX endpoint generates a continuous 20-second shot. It uses the scene description for both shots and asks the second shot for a distinct camera angle. A cut is expected; character identity and continuous motion across it are not guaranteed. Both shots must be genuinely generated and downloaded. The app keeps each completed shot across interruptions, validates decoded source durations, trims excess footage, concatenates locally and checks the decoded final duration. A short source clip causes an error; looping and time stretching are not used to manufacture duration. FFmpeg runs locally as a separate process without network inputs. See [its bundled license and build notice](../third-party/FFMPEG-NOTICE.md).

Single-clip LTX 2.3 uses the high-resolution preset; the longer-film workflow uses the publisher's low landscape preset. This describes native requested sizes, not an upscaled-detail claim. AnimateDiff remains a short-animation model. **A real anonymous 15-second film completed on November 6:** two newly generated LTX shots were downloaded, saved, joined and fully decoded as exactly 15 seconds, with zero paid requests. An earlier high-resolution first-shot attempt failed; the completed workflow used native 768 × 512. Twenty-second local assembly passed using controlled fixtures, but a fresh 20-second GPU film has not been tested. A separate real three-second LTX result and a real AnimateDiff result were also downloaded and decoded; the single LTX clip passed studio playback and seeking. See [VALIDATION.md](VALIDATION.md).

## Duration handling

The adapter reads the first explicit numeric duration, for example `5 seconds`, `5-second`, `3.5 sec` or `1.6s`. Bare decade notation such as `1930s` is ignored. A supported single-clip duration is passed to the API while retaining the original prompt. Fixed-length AnimateDiff and legacy LTX reject conflicting explicit durations.

`createVideoPlan('ltx2-story-free', prompt)` defaults to 15 seconds and produces a saved two-shot plan. It removes the original total-duration tokens from the segment prompts, preserves scene text and other action timing, and prefixes each segment with its own canonical duration. Other model IDs return no composition plan. Invalid totals, unsupported precision or oversized prompts fail locally before any metadata or GPU request. There is no separate story endpoint: each planned segment uses the ordinary reviewed `ltx2-free` profile.

A `15-second` single-clip LTX request still fails clearly because that route supports at most 10 seconds. Choosing the longer option does not silently substitute a short video.

## Unavailable model families

| Family | Observed limitation | App behavior |
| --- | --- | --- |
| Wan | [KingNish/wan2-2-fast](https://huggingface.co/spaces/KingNish/wan2-2-fast) accepted an actual anonymous text-only request, then returned `error: null` without a video. Reachable metadata did not prove successful generation. | Disabled in both catalog and submission backend. Existing saved handles remain readable. No working anonymous replacement is claimed. |
| CogVideoX | Publisher [5B source](https://huggingface.co/spaces/zai-org/CogVideoX-5B-Space/blob/12ac7bfd8eb2029aaca463e316dff21bd1e21e45/app.py) reserves 300 GPU seconds; [2B source](https://huggingface.co/spaces/zai-org/CogVideoX-2B-Space/blob/d67f9b392d09bec4b24b39565fcfc9ccd3a38ea7/app.py) reserves 240. Both exceed anonymous allocation. Their demos also state academic/research and experimentation restrictions. | Disabled. Free-account authentication is not configured; no paid fallback. |
| Hunyuan | The verified publisher-endorsed [Hunyuan Video 1.5 demo](https://huggingface.co/spaces/multimodalart/Hunyuan-Video-1-5) requires a reference image. | Disabled in this prompt-only workflow. A working anonymous prompt-only route is not configured. |

The failed Wan service is a community FastVideo distilled Wan 2.2 TI2V **5B** deployment, not the original 14B model. Its [reviewed source](https://huggingface.co/spaces/KingNish/wan2-2-fast/blob/f70992d594d5db9f9e77930048f560d90b53283c/app.py) exposes null-image text generation, but the observed failure has no proven backend cause. The original [Wan-AI/Wan2.1 publisher Space](https://huggingface.co/spaces/Wan-AI/Wan2.1) reported a runtime error during research. Neither source inspection nor a schema response is advertised as a working replacement.

## Free access, pauses and recovery

[Hugging Face ZeroGPU documentation](https://huggingface.co/docs/hub/spaces-zerogpu) currently lists 120 GPU seconds per day for anonymous access and 300 for a free signed-in account. Anonymous use has shared queues and lower priority. Xlarge consumes quota at twice the normal rate. A declared reservation must fit the remaining allocation before the service accepts work.

The two-shot film requires two independently accepted requests. The second may be blocked by quota even after the first completed. The app preserves the finished shot and pauses; continuing after a normal quota reset starts only the unfinished work. It does not reserve two jobs in advance or guarantee both requests fit one day's allocation.

The adapter accepts no authentication tokens or custom credentials. It cannot use an authenticated paid balance through this integration. It does not rotate identities, change IP addresses, switch endpoints after quota refusal or evade limits. The 400-prompt queue stores work; it is not a promise of 400 free videos. Quota errors, service failures and unresolved downloads stop the batch.

Unknown submission outcomes are not automatically retried. Accepted event IDs and actual output addresses are saved. Completed source shots are reused; a local assembly retry does not regenerate them. A Space restart or a lost completion can still make a remote result unrecoverable. No verified public cancellation endpoint is enabled, so accepted work may continue and consume free quota after a cancellation request.

## Reviewed API profiles

Every new enabled-model submission checks the named endpoint, ordered parameter names and Video output component. A hidden or changed schema blocks submission. The Gradio API returns an actual `event_id`, then streams completion events. [Official API guide](https://huggingface.co/docs/hub/spaces-api-endpoints).

| Profile | Metadata | Submit | Default ordered data |
| --- | --- | --- | --- |
| LTX 2.3 detail | `/gradio_api/info` | `/gradio_api/call/generate_video` | `[null,prompt,3,false,42,false,1024,1536]`; a supported explicit duration replaces `3`. |
| LTX 2.3 film shot | Same metadata and endpoint | Same submit path | `[null,segmentPrompt,segmentDuration,false,42,false,512,768]` |
| AnimateDiff Lightning | `/info` | `/call/generate_image` | `[prompt,"epiCRealism","",8]` |
| Legacy LTX | `/gradio_api/info` | `/gradio_api/call/text_to_video` | `[prompt,negativePrompt,null,null,512,704,"text-to-video",2,9,42,true,1,false]` |

The [LTX source revision](https://huggingface.co/spaces/Lightricks/LTX-2-3/blob/6de521ae21ab2aa37d4f8b2f350d8dfbcce47cb2/app.py) accepts null images for text-only generation. Output index zero is direct FileData. AnimateDiff and legacy LTX return VideoData containing nested `video` FileData. The [AnimateDiff publisher source](https://huggingface.co/spaces/ByteDance/AnimateDiff-Lightning/blob/b8bee4996684de3c12ed3138ce350c05e7a0ca47/app.py) exports frames at 10 fps; [Diffusers documents the default 16 frames](https://huggingface.co/docs/diffusers/api/pipelines/animatediff).

The [current publisher source](https://huggingface.co/spaces/Lightricks/LTX-2-3/blob/main/app.py) was rechecked on November 6: its low landscape preset is width 768, height 512, with the same 75-second GPU reservation and 1–10 second slider. The provider accepts only the reviewed `detail` or `film` preset names; it exposes no custom dimensions or custom endpoint option. The app selects `film` specifically for planned longer-film shots. Reducing pixel area does not establish a proven cause for the earlier failure or guarantee the next request succeeds.

The failed Wan profile is retained only for saved-request compatibility; new submissions are blocked before metadata access. Its historical default payload was `[null,prompt,896,896,negativePrompt,5,0,8,42,false]` at `/gradio_api/call/generate_video`.

Only exact reviewed HTTPS Space origins and Gradio file routes are accepted. The provider does not create a fake media result. For the observed Gradio 4 AnimateDiff response, `FileData.url` incorrectly included `/call/gen/file=` before its cache path. The adapter normalizes that specific prefix to the documented root `/file=` route only when the exact publisher origin and actual returned `/tmp/gradio/<hash>/<hex>.mp4` path match. A real canonical media GET succeeded; mismatched hosts, paths or credentials are rejected.

Redirects, custom endpoints and credential/header options are rejected. Event monitoring has time, total-size and message-size bounds and supports fragmented CRLF events. Gradio completion streams are not durable replay stores; the actual returned media address is persisted before downloading so an interrupted download does not depend on replaying a consumed event.

## Licenses and verification

- [LTX 2.3](https://huggingface.co/Lightricks/LTX-2.3) uses the LTX-2 Community License Agreement.
- [AnimateDiff Lightning](https://huggingface.co/ByteDance/AnimateDiff-Lightning/blob/main/LICENSE.md) and its [epiCRealism base](https://huggingface.co/emilianJR/epiCRealism) use CreativeML OpenRAIL-M.
- The unavailable [FastVideo Wan 5B model](https://huggingface.co/FastVideo/FastWan2.2-TI2V-5B-FullAttn-Diffusers) is marked Apache 2.0. [CogVideoX-2B](https://huggingface.co/zai-org/CogVideoX-2b/blob/main/LICENSE) uses Apache 2.0; [CogVideoX-5B](https://huggingface.co/zai-org/CogVideoX-5b/blob/main/LICENSE) has a separate custom license. Hosted demo restrictions are separate from model licenses.

No video-model weights are included in the installer. Publisher terms govern use of their public services. The studio's MIT license does not replace model, runtime or media-tool terms. Provider contract tests use injected network responses; they do not consume GPU quota. Current observed tests, live generation and packaging results belong in [VALIDATION.md](VALIDATION.md).
