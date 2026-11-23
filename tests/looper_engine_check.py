"""Deterministic regression check for the Looper AI provider boundary."""
import os
import pathlib
import secrets
import shutil
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from app import looper


def main():
    duration = 4.0
    folder = pathlib.Path(__file__).resolve().parents[1] / "workspace" / "tmp" / ("looper-test-" + secrets.token_hex(5))
    folder.mkdir(parents=True)
    try:
        folder = str(folder)
        source = os.path.join(folder, "mix.wav")
        time = np.arange(round(duration * looper.SR)) / looper.SR
        tone = .18 * np.sin(2 * np.pi * 220 * time)
        sf.write(source, np.column_stack((tone, tone)), looper.SR, subtype="PCM_16")
        for number, prompt in enumerate(("lo-fi drum beat", "funky bassline", "warm synth pad")):
            output = os.path.join(folder, "stem-%d.wav" % number)
            analysis, provider = looper.generate_layer(source, output, prompt, duration, 120, "A minor", "Am,F,C,G")
            info = sf.info(output)
            assert provider == "local-placeholder"
            assert info.frames == round(duration * looper.SR), (prompt, info.frames)
            assert info.channels == 2 and info.samplerate == looper.SR
            assert analysis["bpm"] == 120 and analysis["chords"] == ["Am", "F", "C", "G"]
            print("%s: %d frames, %.3f s" % (prompt, info.frames, info.duration))
    finally:
        shutil.rmtree(folder, ignore_errors=True)


if __name__ == "__main__":
    main()
