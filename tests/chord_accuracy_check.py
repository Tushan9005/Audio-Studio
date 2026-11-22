"""Small deterministic chord-detector benchmark; run directly, no pytest needed."""
import math
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from app import ops


SR = 22050
CHORDS = ["C", "Am", "F", "G", "Em", "Dm", "A", "E"]
ROOTS = {name: i for i, name in enumerate(ops._KEYS)}


def synthesize():
    seconds_per_chord = 2.0
    y = np.zeros(int(SR * seconds_per_chord * len(CHORDS)), dtype=np.float32)
    rng = np.random.default_rng(42)
    for number, chord in enumerate(CHORDS):
        minor = chord.endswith("m")
        root_name = chord[:-1] if minor else chord
        root = ROOTS[root_name]
        tones = [root, (root + (3 if minor else 4)) % 12, (root + 7) % 12]
        start = int(number * seconds_per_chord * SR)
        for beat in range(4):
            offset = start + int(beat * .5 * SR)
            length = min(int(.48 * SR), len(y) - offset)
            t = np.arange(length) / SR
            envelope = np.exp(-4.2 * t)
            for string, pc in enumerate(tones):
                midi = 48 + pc
                while midi < 52 + string * 2:
                    midi += 12
                frequency = 440 * 2 ** ((midi - 69) / 12)
                y[offset:offset + length] += (.13 / (string + 1)) * envelope * (
                    np.sin(2 * math.pi * frequency * t)
                    + .35 * np.sin(4 * math.pi * frequency * t)
                )
            y[offset:offset + min(220, length)] += rng.normal(0, .025, min(220, length))
    # A quiet, deliberately independent melody simulates a singer over the guitar.
    t = np.arange(len(y)) / SR
    y += (.025 * np.sin(2 * math.pi * (235 + 18 * np.sin(2 * math.pi * .19 * t)) * t)).astype(np.float32)
    return y


def main():
    y = synthesize()
    ops.get = lambda _fid: {"id": "benchmark", "kind": "audio", "duration": len(y) / SR}
    ops._load_mono = lambda _item, max_s=1200: (y, SR)
    report = ops.analyse_chords("benchmark")
    predicted = []
    for number in range(len(CHORDS)):
        midpoint = number * 2 + 1
        row = next(segment for segment in report["segments"] if segment["start"] <= midpoint < segment["end"])
        predicted.append(row["chord"])
    correct = sum(actual == heard for actual, heard in zip(CHORDS, predicted))
    accuracy = correct / len(CHORDS)
    print("expected:", CHORDS)
    print("detected:", predicted)
    print("accuracy: %.1f%%" % (accuracy * 100))
    if accuracy < .75:
        raise SystemExit("Chord detector benchmark fell below 75%")


if __name__ == "__main__":
    main()
