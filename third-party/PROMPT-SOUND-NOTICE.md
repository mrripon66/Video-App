# Prompt sound · Powered by Stability AI

The optional prompt sound engine uses Stable Audio 3 Small SFX with the
SAME-S decoder and T5Gemma text encoder. Inference runs locally on Windows x64
through the official LiteRT runtime. The setup downloads about 1.20 GB of
model weights and verifies each weight file against its pinned SHA256 hash.
The verified installed engine, including CPU caches, occupies about 1.88 GB.

This Stability AI Model is licensed under the Stability AI Community License,
Copyright © Stability AI Ltd. All Rights Reserved

The model weights are provided under the [Stability AI Community License](prompt-sound/STABILITY-AI-COMMUNITY-LICENSE.md).
The model license covers free research and non-commercial use and eligible
commercial use under its stated conditions, including registration for
commercial use. The T5Gemma component carries separate [Gemma terms](prompt-sound/GEMMA-TERMS.md)
and an upstream [notice](prompt-sound/UPSTREAM-NOTICE.txt). The official
inference source is available under the [MIT license](prompt-sound/MIT.md).
The Studio installer contains the integration and these notices. The optional
model weights and Python runtime are installed per user, outside the app
installer.

Upstream sources:

- [Stable Audio 3 Windows CPU instructions](https://github.com/Stability-AI/stable-audio-3/blob/790793b89ddceea612be9ce42ff6830d18f6fa57/optimized/tflite/README.md)
- [Pinned optimized model files](https://huggingface.co/stabilityai/stable-audio-3-optimized/tree/30cb2644da54bfa63275d1bc7f1fa67fc718680f)

## Setup and verification

Run `scripts/setup-prompt-sound.py` with 64-bit Python 3.12 and its output
directory set to `%LOCALAPPDATA%\AI Video Studio\prompt-sound`. The setup writes
its readiness marker only after creating and checking a five-second sound on
the CPU. After setup, generation uses the cached model offline.

On the tested Windows Ryzen 7 5700G computer, the app integration generated a
15.00-second stereo rain sample in 14.66 seconds. From the installed per-user
engine it generated a 5.00-second stereo door-and-footsteps sample in 7.70
seconds. Both files contained non-silent 44.1 kHz PCM. These measured times
describe those prompts on that computer.
