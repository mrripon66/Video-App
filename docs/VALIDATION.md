# Validation record

Verification date: November 5, 2026. This record distinguishes local checks from provider functionality that requires a live account and spending approval.

## Automated checks

| Check | Result recorded so far | What it establishes |
| --- | --- | --- |
| Store and queue unit tests | 21 passed | Atomic persistence, backup recovery, 400 active-prompt capacity, exact approval IDs, paused restart, uncertain-submission handling, saved-request monitoring, download retry, cancellation races, and automatic pause on download/account/rate failures. |
| Provider contract unit tests | 10 passed | Request and response handling against documented fal queue contracts, trusted addresses, error handling, and cancellation responses using injected network fixtures. |
| Credential and download unit tests | 12 passed | Encrypted credential persistence contract, refusal without OS protection, credential removal, trusted downloads, redirect restrictions, output container checks, and partial-file cleanup. |
| Electron desktop smoke test | Passed | The real Electron app accepts 400 prompts, protects credentials with Windows storage, presents an exact batch review, persists the queue and key across restart, and starts paused. The test records zero network requests. |
| Electron recovery regression | Passed | A saved remote request with zero new pending prompts can resume through the monitoring-only review. Only injected status GET responses are read; there are zero provider submissions or real network requests. Attention items count toward capacity, removal frees capacity, and unconfirmed cancellation details are visible. |
| Real-media library regression | Passed | A pinned official Chromium video decodes, plays, seeks, and supports correct local byte ranges. Invalid identifiers, traversal and bad ranges are rejected. This test fixture is excluded from the installer. |
| Offline CPU transcription | Passed | The bundled Whisper tiny model transcribed a hash-verified official speech sample in about one second. No microphone was recorded and no paid service was used. |
| Windows installer build and launch | Passed locally | NSIS installer completed with exit code 0, created desktop and Start menu shortcuts, and installed version 1.0.0 launched successfully with all five models, offline voice available, a paused queue, and zero provider requests. The installed voice engine also passed actual sample transcription. |

The unit suite contains 43 passing tests. The core tests were executed on Windows with Node.js 26.13.0. Test data is isolated from the user's real studio data. Network responses and synthetic container fixtures used by unit tests are not production videos and are never added to the shipped application's library. Desktop test evidence is written to the ignored `test-results/` folder.

## Safety and recovery checks

- Adding, importing, editing, or reviewing prompts does not submit generation requests.
- A start request must contain exactly the current pending prompt IDs. New prompts require a fresh approval.
- Every launch starts paused. A saved remote request is monitored using its request reference; the app does not automatically submit a replacement.
- A missing submission acknowledgement is treated as uncertain because the provider may already have accepted and charged for the request.
- Restoring a backup can restore state from before a submission. Active prompts with no remote reference are therefore held for attention and require a manual retry after checking the provider dashboard.
- A failed download preserves the generated output URL so downloading can be retried without another generation request.
- A cancellation request is distinguished from provider-confirmed cancellation. Pausing or closing the app cannot guarantee that a provider stops an accepted request or reverses a charge.
- Credentials are stored separately from queue JSON. Production protection uses Electron's Windows safe storage; the unit-test encryption fixture is only a test double.

## Checks that require a live environment

No billable video generation has been performed. Provider adapters have been checked against official documentation and local contract fixtures, rather than a paid end-to-end generation. Account access, endpoint availability, provider pricing, generated content quality, and successful playback of an actual provider-generated result remain to be verified with the user's chosen account and explicit credit approval.

Voice uses Windows speech recognition where available, with a bundled offline Whisper CPU fallback. Actual offline inference on a public sample passed. Windows reports one recording device on the execution host, but no microphone audio was captured during verification. Microphone quality, privacy permissions, and a spoken prompt remain a physical microphone check. Dictation does not call a video provider.

The locally built installer is unsigned; no publisher certificate was supplied. Source and pull request #1 are published to the authorized GitHub repository. The Windows workflow is published after workflow access was approved; its hosted build is in progress as of this record.

## Review follow-ups

The independent integration review identified saved-request monitoring with no pending prompts, attention-item capacity accounting, retry versus recovery wording, cancellation visibility, and credential-update races. Monitoring, capacity, local removal, and cancellation visibility now have a passing desktop regression. Retry wording and credential updates were reviewed in code; the final release should retain the automated suite and both desktop scripts.
