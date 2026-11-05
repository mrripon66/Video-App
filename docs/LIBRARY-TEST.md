# Real-media desktop regression

Run `npm run test:library` after installing development dependencies.

The regression downloads the small, real `bear.webm` media fixture from the
[official Chromium repository at revision 92146310d35807e58f0d376e8ad9908ba2f4f92f](https://github.com/chromium/chromium/blob/92146310d35807e58f0d376e8ad9908ba2f4f92f/media/test/data/bear.webm).
The 58,199-byte fixture must match SHA-256
`7148402273737217b6906704ac430fcfd77268e9f0dbfe19d5f334a496a58d69`
before it is used or cached. Chromium's repository contains its
[license and third-party notices](https://github.com/chromium/chromium/blob/92146310d35807e58f0d376e8ad9908ba2f4f92f/LICENSE).

The video is explicitly labelled **TEST FIXTURE** in a fresh, isolated workspace.
It is not represented as generated output. The fixture cache and test workspaces
live under ignored `test-results/`, and are excluded from the Windows installer.
No existing user files, production jobs, or credentials are read or changed.

The test launches the actual Electron desktop application, blocks its provider
network function, then verifies decoded dimensions and duration, advancing
playback, seeking, exact and suffix byte-range responses, invalid-range rejection,
unknown video IDs, encoded path traversal, and unknown protocol hosts. It confirms
zero provider requests. Screenshots and the machine-readable outcome are saved to
`test-results/library-playback.png` and `test-results/library-summary.json`.

This checks local media behavior. It does not spend provider credits or claim
that any paid video model has been exercised.
