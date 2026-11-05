# Validation record

Verification date: November 5, 2026. This record identifies checks completed locally and checks still pending for the free-only version 1.1.

## Automated checks

`npm test` currently passes **62 tests** on Windows with Node.js 26.13.0:

| Group | Result | Scope |
| --- | ---: | --- |
| Store and queue | 24 passed | Atomic persistence, backups, 400 active prompts, exact reviewed IDs, paused restarts, uncertain submission handling, saved-request monitoring, download recovery, cancellation races, single-flight operations and stopping the batch on provider/quota signals. |
| Free LTX provider | 14 passed | Anonymous fixed-origin requests, credential/custom-endpoint rejection, live-schema preflight contract, Gradio event handles, fragmented CRLF SSE, returned VideoData, quota stops, failed streams, bounded time/size, and unsupported cancellation. Network responses are injected test fixtures. |
| Credential vault and downloader | 14 passed | Encryption/storage contracts retained from the earlier implementation; trusted media hosts, redirects, atomic saves, container screening, valid empty MP4 `free`/`skip` boxes, and partial-file cleanup. The free-only UI does not configure provider credentials. |
| Legacy paid-provider contract | 10 passed | Historical fal request handling. These tests do not make paid calls; the free-only desktop factory does not enable that provider. |

The free provider's read-only checks found the official Lightricks Space running on ZeroGPU, with HTTP 200 for `/config`, `/gradio_api/info` and `/gradio_api/openapi.json`. Its actual ordered text-to-video inputs and VideoData output match the adapter. Metadata inspection alone does not prove a generated video's quality or successful playback.

The following desktop checks passed for the free-only 1.1 source:

| Desktop check | Observed result |
| --- | --- |
| 400-prompt persistence and review | Passed. The queue imports 400 prompts, enforces capacity, presents the exact reviewed batch, and remains paused across restart. Test networking is blocked. |
| Saved-request recovery | Passed. With zero new pending prompts, the monitoring-only review resumes a saved anonymous Gradio event stream. Attention items count toward capacity; removing one frees capacity. Unconfirmed cancellation details are visible. There are zero generation submissions and zero real network requests in this regression. |
| Local video library | Passed. The library regression verifies playback, seeking and byte ranges using an official test video fixture, rather than a generated-provider output. |

The earlier 1.0 Windows installer was built, installed and checked successfully. **The final updated free-only 1.1 installer and its installed application have not yet been verified.** Earlier installer results do not establish that the changed 1.1 package works.

## Live free generation

One anonymous free GPU generation request was accepted and completed by the provider, which returned a video URL. The application's downloader rejected that output's container before it could become a completed local-library video. Therefore, **successful live end-to-end generation, download and playback have not been established**.

The subsequent local fix accepts valid empty MP4 `free` and `skip` boxes, addressing the suspected container-compatibility issue while retaining other screening checks. All 62 unit tests pass with the fix. A live follow-up is still needed to prove that the returned provider output can be saved and played; a local test pass does not replace that check.

Further live follow-up and updated installer/install checks are currently blocked because automatic approval review reached its usage limit for new elevated operations. No alternate agent, shell or browser was used to bypass that restriction. Offline code review, documentation and tests remain available. No authenticated or paid fallback is permitted.

## Recovery and cost boundary

- Adding, importing and reviewing prompts does not run video generation.
- Starting requires exactly the current reviewed prompt IDs; later additions need another review.
- Every launch starts paused. Saved request IDs are preserved without automatic replacement submissions.
- A lost acknowledgement is treated as uncertain because a request may have consumed free quota.
- Restored backups quarantine ambiguous active work rather than silently repeating it.
- Download failures preserve the actual output URL for download-only recovery.
- Quota and service errors pause the remaining batch. The app does not switch identities, providers or authentication to bypass limits.
- The public Gradio integration has no verified cancellation endpoint. The app reports cancellation as unconfirmed; the accepted request may finish and consume free quota.
- The free adapter accepts no tokens, provider keys or custom request headers. Requests omit credentials and cannot use a paid balance through an authenticated account.
- A 400-prompt persistent queue is not a promise of 400 free remote videos or uninterrupted shared-GPU access.

## Offline voice and media

Earlier offline voice validation used the bundled Whisper tiny multilingual model for real CPU transcription of a hash-verified official speech fixture, using four threads, in approximately one second. No microphone was captured and no provider credits were used. The bundled runtime includes the required app-local Microsoft DLLs. This verifies executable dependencies and local inference in the tested build. Microphone privacy settings, input quality and speech recognition for the user's voice remain physical-device checks.

The media downloader screens supported MP4/WebM container structure and complete byte counts, rejects HTML, still-image brands and truncated headers, and cleans partial files. Container screening is not full decoder validation. The separate library regression uses a pinned official Chromium video fixture to check decoding, playback, seeking and byte ranges; that fixture is excluded from the installer.

The Windows installer is unsigned because no publisher certificate was supplied. GitHub publication and hosted build results are tracked by the main task and should reflect the current free-only revision before release.
