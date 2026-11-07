# FFmpeg media tool

The installer includes FFmpeg 6.1.1 essentials, Windows x64, built by Gyan Doshi
and distributed through `ffmpeg-static` 5.3.0 (binary release `b6.1.1`).
AI Video Studio invokes this unmodified executable as a separate process to
decode, trim and join real generated video clips locally. It is not a video
generation model. No FFmpeg network input is enabled by the application.

The executable is licensed under GNU GPL version 3. Its original license and
build README are installed beside it in `resources/media/ffmpeg.exe.LICENSE`
and `resources/media/ffmpeg.exe.README`. The README includes the build
configuration and enabled libraries. The studio source is available at
https://github.com/mrripon66/Video-App .

Upstream binary and source references:

- Binary distribution: https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1
- FFmpeg source revision reported by the build: https://github.com/FFmpeg/FFmpeg/commit/e38092ef93
- FFmpeg source archive: https://github.com/FFmpeg/FFmpeg/archive/e38092ef93.tar.gz
- Build publisher and source/build information: https://www.gyan.dev/ffmpeg/builds/
- Binary SHA-256: `04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00`

The root MIT license covers AI Video Studio's original code. Third-party
components retain their respective licenses.
