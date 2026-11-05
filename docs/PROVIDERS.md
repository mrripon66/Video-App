# Remote video providers

Official documentation checked on **November 5, 2026**. All five requested model families have a documented text-to-video endpoint on fal, so this version uses one fal account and key. Video computation runs on fal's GPUs, not on the Windows PC.

| App choice | Exact endpoint | Input used | Official source |
| --- | --- | --- | --- |
| Wan 2.1 | `fal-ai/wan-t2v` | Prompt; provider defaults, including 720p | [Wan API](https://fal.ai/models/fal-ai/wan-t2v/api) |
| LTX 2.3 Fast | `fal-ai/ltx-2.3/text-to-video/fast` | Prompt; 6 seconds, 1080p, 25 fps, audio disabled | [LTX API](https://fal.ai/models/fal-ai/ltx-2.3/text-to-video/fast/api) |
| CogVideoX-5B | `fal-ai/cogvideox-5b` | Prompt; provider defaults | [CogVideoX API](https://fal.ai/models/fal-ai/cogvideox-5b/api) |
| Hunyuan Video | `fal-ai/hunyuan-video` | Prompt; standard mode | [Hunyuan API](https://fal.ai/models/fal-ai/hunyuan-video/api) |
| AnimateDiff | `fal-ai/fast-animatediff/text-to-video` | Prompt; provider defaults, including 16 frames | [AnimateDiff API](https://fal.ai/models/fal-ai/fast-animatediff/text-to-video/api) |

The app explicitly enables the safety checker. LTX uses the documented 2.3 Fast endpoint; the original assembler's older LTX endpoint was labeled research-only. The assembler's Wan, CogVideoX and abbreviated Replicate AnimateDiff IDs are replaced by the verified IDs above. No Replicate token is needed for these integrations.

## What has and has not been verified

The adapter uses real HTTP requests and parses the provider's actual response. Automated tests replace the network with labeled test fixtures; production has no demo-video fallback. API documentation and request/response handling have been checked. **No paid generation was run**, so account authorization, credit balance, live endpoint uptime, and the resulting video quality remain unverified. A documented endpoint can subsequently become unavailable; the app displays the provider error instead of inventing a result. Provider prices and licenses must be checked on the linked model page before approving a run.

## Queue protocol and failure handling

The adapter submits JSON to `https://queue.fal.run/{endpoint}` and persists the returned request ID plus tracking URLs. Polling follows the submitted request through the provider queue; a completed status is followed by a separate result fetch. The completed result must contain a usable `video.url`. This follows the [official fal queue API](https://fal.ai/docs/documentation/model-apis/inference/queue).

If a submission's acknowledgement is lost, the error is marked `submissionUncertain`. The app must reconcile it with the provider dashboard before another paid submission. It must never silently submit the same job again. Polling a known request does not create another video request.

Cancellation distinguishes a confirmed removal (`200`, `OK`) from a stop request sent to an already running job (`202`, `CANCELLATION_REQUESTED`). Running requests can still complete. An already completed request is not reported as successfully cancelled.

## Credential and media boundaries

Only the desktop main process handles the fal key. Keyed HTTP requests are restricted to HTTPS on `queue.fal.run`, with redirects disabled. Saved request addresses are checked against their request ID and the supported endpoint family before use. Errors redact the configured key.

Returned media URLs accept HTTPS on `fal.media` and its subdomains. The exact legacy host `fal-cdn.batuhan-941.workers.dev` is also accepted because it appears in the official AnimateDiff response schema. Media downloads do not receive the provider key. If fal changes its CDN, the app fails with an actionable error until the new address is reviewed. Files should be saved locally because [fal's media links can expire](https://fal.ai/docs/documentation/model-apis/inference/queue).

Downloads screen the first 4 KB and the complete byte count: MP4 requires a supported file-type brand and a sized movie/media box; WebM requires an EBML `webm` DocType and a segment containing a recognized child element. Known still-image brands, HTML, magic-only stubs and declared container sizes exceeding the file are rejected. This follows the container structure described by [W3C's ISO BMFF guidance](https://www.w3.org/TR/mse-byte-stream-format-isobmff/) and the [WebM Project guidelines](https://www.webmproject.org/docs/container/). Header screening does not establish that every frame is decodable; the local video player performs decoding.

## Maintaining a model integration

Update `src/core/providers.js` only after checking the model's official API page. Keep endpoint identifiers and supported options explicit. If a model cannot be verified, set its catalog entry to `available: false` with a clear `reason`, which prevents submission. Do not infer endpoint IDs from model names or short version hashes. Provider tests must cover the actual submission, tracking, result and cancellation contracts without using live credits.
