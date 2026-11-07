# Validation record

Updated November 6, 2026 for version 1.2. A real anonymous 15-second two-shot film completed, and source, package, installed-upgrade and actual generated-video playback checks passed. GitHub publication remains a separate pending step.

## Current source checks

The final `npm test` run passed **100 tests**, including **39 queue tests**, **31 provider tests** and real FFmpeg assembly checks. Syntax checks also passed. The selected film preset is the publisher's native 768 × 512 landscape preset; direct detail clips retain 1536 × 1024.

Provider contracts cover anonymous requests, exact schema ordering and origins, prohibited credentials/custom endpoints, bounded fragmented CRLF streams, quota pauses, saved-handle compatibility, requested durations, the two-shot plan, backend rejection of the failed Wan service, observed AnimateDiff file-URL normalization, and strict detail/film presets. All provider responses in these tests are injected fixtures; no GPU generation is performed. Real local FFmpeg assembly tests validate the executable and duration checks using controlled test media; they are not evidence of fresh AI-generated source shots.

All three desktop checks passed: direct generation and queue behavior, saved-request recovery, and local-library playback. The unpacked packaged-app smoke check also passed with a 15-second local fixture and the bundled FFmpeg executable. All 14 application JavaScript/HTML/CSS files inspected matched the source revision in the package. Those fixture-based checks are distinct from the real fresh 15-second GPU workflow below. A fresh 20-second GPU workflow has not been run.

Desktop regression coverage includes direct **Generate** and **Generate batch** without review or approval dialogs, selection of newly added jobs, preserving unrelated pending work, 400-prompt persistence, longer-film handling and paused restart. Provider networking is intercepted for these automated checks. Existing evidence includes `test-results/desktop-summary.json`, `test-results/one-click-summary.json` and the recovery/library summaries.

The local installer successfully upgraded the application to **version 1.2.0**. The packaged-app smoke check passed against the actual installed path, including the bundled media executable, voice resources and direct generation flow, with **zero network requests**. Existing app data was preserved. The library contains one imported real 15-second validation sample, recorded as a saved job; this sample is an actual generated film rather than a simulated provider result. GitHub publication remains pending.

## Real anonymous provider outputs

| Service | Observed result | Evidence and limit |
| --- | --- | --- |
| LTX 2.3 two-shot film | **A real 15-second film completed:** two fresh anonymous GPU clips, requested as 10 + 5 seconds, were downloaded, saved, assembled and fully decoded as **15.0 seconds** at native 768 × 512. Two source clips were retained. A separate Electron playback check decoded 10 frames, advanced playback and sought successfully without errors or further GPU requests. | `../quality-tests/ltx-story-15/report.json` and its `studio.json` preserve both actual request IDs, segment progress and the failed earlier attempt. Final file: `videos/9cccb95b-fa27-4ea9-85b3-8f7b20e02ac7.mp4`. Completed at `2026-11-06T22:44:20.166Z`; anonymous access, **zero paid requests**. This validates the complete 15-second pipeline, not perfect realism or a fresh 20-second GPU result. |
| LTX 2.3 | A requested three-second whale clip completed, downloaded and played through the studio's real media protocol. The decoded output was **1536 × 1024, 3.041667 seconds**, 1,817,896 bytes. Playback advanced, decoded frames were observed and seeking succeeded. | `test-results/ltx2-generated-summary.json`; `../quality-tests/ltx2-free/report.json`. Completed at `2026-11-06T00:30:11.616Z`. Playback verification blocked all network and made no additional GPU calls. This proves real output and playback, not perfect anatomy or visual quality. |
| AnimateDiff Lightning | A real anonymous request completed. Its Gradio 4 response contained an incorrect `/call/gen/file=` URL prefix. After strict normalization from matching FileData, the **217,322-byte MP4** was downloaded and fully decoded by FFmpeg as **1.6 seconds**. Electron playback also passed at **512 × 512**, with 7 decoded frames, zero dropped frames and zero network requests. | `../quality-tests/animatediff-free/diagnostic-2/report.json`. Recovery at `2026-11-06T10:03:43.326Z` used the captured completion and made **zero additional generation requests**. |
| Wan 2.2 Fast 5B | The service accepted an anonymous request, then emitted an error without a reason or video. | `../quality-tests/wan-free/report.json`, completed at `2026-11-06T09:53:22.333Z`. A schema check was insufficient. Wan is disabled for new submissions in both catalog and backend. |
| Legacy LTX 0.9.8 | An earlier real free request downloaded a 116,582-byte MP4; studio playback decoded 704 × 512 and about 1.9 seconds, with seeking. | `test-results/free-generated-summary.json`. Historical compatibility evidence, not the new LTX 2.3 or long-film workflow. |

These live requests used anonymous public services and made zero paid API requests. Automated CI tests remain offline with respect to GPU generation. No quality guarantee is inferred from a successful download or decode.

## Longer-film implementation and observed result

The `ltx2-story-free` option plans 15–20 seconds, defaulting to 15. It requests two independent LTX clips, **10 seconds plus the remainder**, rather than looping or slowing a short clip. Per-shot prompts begin with their own durations and remove the original total-duration instruction. The second shot requests a distinct angle; a cut and possible continuity differences are disclosed.

The local composer uses bundled FFmpeg 6.1.1 as a separate process. It checks decoded source durations, joins two sources at 768 × 512/24 fps without audio, and decodes the final file to check its duration before returning success. Short or undecodable sources cause an error. Real local assembly tests passed for 15 and 20 seconds using controlled fixtures; the separate live 15-second provider film also completed these checks. No fresh 20-second GPU generation was performed.

A fresh long-film test first submitted a ten-second shot at the 1536 × 1024 detail preset at `2026-11-06T22:36:47Z`. The provider returned an error without details around `22:38:56Z`, with zero completed source clips from that attempt. This does not prove whether GPU runtime, memory or another service failure caused it. The longer-film profile was changed to the publisher's supported low landscape preset, **768 × 512 native**, retaining the same endpoint, frame rate and 75-second reservation. A subsequent normal anonymous attempt completed the ten-second shot at `22:43:47.334Z`, the five-second shot at `22:44:18.712Z`, and the final decoded 15-second file at `22:44:20.166Z`. Attempt history remains saved; no failed attempt is represented as a successful clip.

Each LTX shot declares 75 seconds of GPU allocation. A future second shot may not fit the remaining anonymous quota even though this test completed. Queue tests verify preserving completed source clips, pausing on quota refusal and continuing unfinished work. Recovery and assembly retries reuse successful generation rather than automatically repeating it. The observed success does not promise uninterrupted free access or identical future service behavior.

The media setup checks the reviewed Windows executable's SHA-256 before staging it, and packages its original license and build README. See [FFmpeg notice](../third-party/FFMPEG-NOTICE.md). CI and local packaging must run `npm run setup:media` as well as voice setup.

## Recovery and cost boundary

- Adding or importing a prompt does not generate video. A direct Generate/Generate batch/Start queue click authorizes the selected work; no second approval popup is required.
- Every launch starts paused. Saved request IDs and returned media addresses are retained; ambiguous acknowledgements are not automatically resubmitted.
- Download recovery uses the saved actual output URL. Gradio completion events can be consumed once, so recovery must not rely on replaying an old completion stream.
- Finished source clips are retained for longer-film recovery. Retrying local assembly should use those files without a GPU request. An unsubmitted second shot still requires its own normal free request when continued.
- Quota and service errors pause remaining work. The app never switches identity, network address, authentication or provider to bypass limits.
- Cancellation is unconfirmed through the public API; accepted remote work may continue and consume free quota.
- The free adapter accepts no tokens, keys or custom request headers and omits cookies. Historical paid integrations are disabled.
- A persistent 400-prompt queue is not a promise of 400 free videos or uninterrupted access.

## Offline voice, media and release boundaries

Bundled Whisper tiny multilingual previously transcribed a hash-verified official speech fixture on CPU with four threads in approximately one second. This tested actual local inference and the app-local executable dependencies, without recording the microphone or consuming provider credits. It does not benchmark local video generation. Microphone permissions, recording hardware and recognition of the user's own speech remain physical-device checks.

The downloader rejects untrusted hosts, redirects, HTML, still-image container brands and incomplete byte counts, and removes partial files. Container screening is not full decoder validation. The library regression uses a pinned official Chromium video fixture for playback, seeking and byte ranges; that fixture is excluded from the installer. The real LTX playback evidence above is separate from that fixture test.

The Windows installer is unsigned because no signing certificate was supplied. Source tests, real 15-second generation, actual generated-video playback, unpacked package checks, the installed upgrade and installed-resource checks passed for 1.2.0. GitHub commit/PR, hosted CI and release publication are pending and are not claimed as completed by this record.
