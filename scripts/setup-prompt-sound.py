"""Prepare the official Stable Audio 3 CPU engine for AI Video Studio."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request
import wave


SOURCE_REVISION = "790793b89ddceea612be9ce42ff6830d18f6fa57"
WEIGHT_REVISION = "30cb2644da54bfa63275d1bc7f1fa67fc718680f"
SOURCE = "https://raw.githubusercontent.com/Stability-AI/stable-audio-3/" + SOURCE_REVISION
WEIGHTS = "https://huggingface.co/stabilityai/stable-audio-3-optimized/resolve/" + WEIGHT_REVISION
FILES = {
    "tflite/t5gemma/encoder_fp16.tflite": "8530d0b3e6b9b9dcf1239145c2a853fb749708eaddbb472ff8f0802b50059372",
    "tflite/sa3-sm-sfx/dit_w8a8.tflite": "d3f99409f446eff9a625768ba2ee09a2347ea90c4897c1662fbcd8837fae3045",
    "tflite/same-s/dec_w8a8.tflite": "2fc31cdc42a54342233fb8c6da636565b1191d97002665e21812e981490434a6",
    "tokenizer.model": "61a7b147390c64585d6c3543dd6fc636906c9af3865a5548f27f31aee1d4c8e2",
}
RUNTIME_FILES = (
    "scripts/sa3_tflite.py", "scripts/weights.py", "scripts/rung_dit.py",
    "scripts/rung_decoder.py", "scripts/rung_encoder.py", "models/defs/__init__.py",
    "models/defs/tflite_pipeline.py",
)
LAUNCH = "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_path(sys.argv.pop(1),run_name='__main__')"
ATTRIBUTION = "This Stability AI Model is licensed under the Stability AI Community License, Copyright © Stability AI Ltd. All Rights Reserved"


def get_file(url, target, expected=None, maximum=620_000_000):
    if expected and target.is_file():
        with target.open("rb") as existing:
            if hashlib.file_digest(existing, "sha256").hexdigest() == expected:
                print(f"Verified {target.name}", flush=True)
                return
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=".download-", dir=target.parent)
    temporary = Path(temporary_name)
    try:
        print(f"Downloading {target.name}", flush=True)
        request = urllib.request.Request(url, headers={"User-Agent": "AI-Video-Studio-Prompt-Sound/1.0"})
        count = 0
        digest = hashlib.sha256()
        with os.fdopen(fd, "wb") as output, urllib.request.urlopen(request, timeout=90) as response:
            if not response.geturl().startswith("https://"):
                raise RuntimeError("The download was redirected away from HTTPS.")
            while data := response.read(1024 * 1024):
                count += len(data)
                if count > maximum:
                    raise RuntimeError(f"Unexpected download size for {target.name}.")
                digest.update(data)
                output.write(data)
        if not count and target.name != "__init__.py":
            raise RuntimeError(f"Empty download for {target.name}.")
        if expected and digest.hexdigest() != expected:
            raise RuntimeError(f"SHA256 verification failed for {target.name}.")
        temporary.replace(target)
        print(f"Prepared {target.name} ({count:,} bytes)", flush=True)
    finally:
        temporary.unlink(missing_ok=True)


def local_environment():
    environment = os.environ.copy()
    for key in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_HUB_TOKEN", "PYTHONPATH", "PYTHONHOME"):
        environment.pop(key, None)
    environment.update(HF_HUB_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1", PYTHONUTF8="1")
    return environment


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="The isolated per-user sound engine directory.")
    options = parser.parse_args()
    if sys.platform != "win32" or sys.maxsize <= 2 ** 32 or sys.version_info[:2] != (3, 12):
        parser.error("Use 64-bit Python 3.12 on Windows.")
    root = options.directory.resolve()
    engine = root / "engine"
    dependencies = root / "python-deps"
    ready = root / "ready.json"
    root.mkdir(parents=True, exist_ok=True)
    if ready.exists():
        try:
            installed = json.loads(ready.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            installed = {}
        if (isinstance(installed, dict) and installed.get("schema") == 1 and installed.get("python") == sys.executable
                and installed.get("model") == WEIGHT_REVISION and installed.get("source") == SOURCE_REVISION
                and dependencies.is_dir() and all((engine / name).is_file() for name in RUNTIME_FILES)
                and all((engine / "models" / name).is_file() for name in FILES)):
            print("The local sound engine is already installed.", flush=True)
            return
        ready.unlink()

    with ThreadPoolExecutor(max_workers=4) as workers:
        downloads = [workers.submit(get_file, WEIGHTS + "/" + name, engine / "models" / name, digest)
                     for name, digest in FILES.items()]
        downloads.extend(workers.submit(get_file, SOURCE + "/optimized/tflite/" + name, engine / name, maximum=300_000)
                         for name in RUNTIME_FILES)
        downloads.extend(workers.submit(get_file, WEIGHTS + "/" + name, root / name, maximum=100_000)
                         for name in ("LICENSE.md", "LICENSE_GEMMA.md", "NOTICE"))
        downloads.append(workers.submit(get_file, SOURCE + "/LICENSE", root / "LICENSE_SOFTWARE.md", maximum=100_000))
        subprocess.run([sys.executable, "-I", "-m", "pip", "--isolated", "install", "--disable-pip-version-check",
                        "--no-input", "--index-url", "https://pypi.org/simple", "--only-binary=:all:", "--target", str(dependencies),
                        "ai-edge-litert==2.3.0", "numpy==2.5.4", "sentencepiece==0.2.1", "soundfile==0.13.1"],
                       check=True, timeout=600, env=local_environment())
        for download in downloads:
            download.result()

    (root / "NOTICE_STABILITY_AI.txt").write_text(ATTRIBUTION + "\n", encoding="utf-8")
    scratch = Path(tempfile.mkdtemp(prefix="smoke-", dir=root))
    sample = scratch / "test.wav"
    try:
        print("Testing genuine local sound generation on this computer.", flush=True)
        start = time.monotonic()
        subprocess.run([sys.executable, "-I", "-u", "-c", LAUNCH, str(dependencies), str(engine / "scripts/sa3_tflite.py"),
                        "--prompt=Light rain pattering on a kitchen window, quiet indoors", "--dit=sm-sfx", "--decoder=same-s",
                        "--precision=w8a8", "--seconds=5", "--steps=8", "--threads=4", "--seed=1717", f"--out={sample}"],
                       cwd=engine, check=True, timeout=720, env=local_environment())
        elapsed = round(time.monotonic() - start, 2)
        with wave.open(str(sample), "rb") as output:
            if (output.getnchannels(), output.getsampwidth(), output.getframerate(), output.getnframes()) != (2, 2, 44100, 220500):
                raise RuntimeError("The CPU test did not produce a valid five-second stereo WAV.")
            if not any(output.readframes(output.getnframes())):
                raise RuntimeError("The CPU test returned silent samples.")
        print(f"Verified five seconds of generated stereo sound in {elapsed} seconds.", flush=True)
    finally:
        sample.unlink(missing_ok=True)
        scratch.rmdir()
    temporary = root / "ready.tmp.json"
    temporary.write_text(json.dumps({"schema": 1, "python": sys.executable, "model": WEIGHT_REVISION,
                                     "source": SOURCE_REVISION, "testSeconds": elapsed}), encoding="utf-8")
    temporary.replace(ready)


if __name__ == "__main__":
    main()
