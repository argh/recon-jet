#!/usr/bin/env python3
"""Quick sanity stats for a captured WAV: duration, channels, RMS and peak in dBFS per channel.
   python3 -I tools/wavstats.py file.wav"""
import sys, wave, struct, math

w = wave.open(sys.argv[1], 'rb')
ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
data = w.readframes(n)
fmt = {1: 'b', 2: 'h', 4: 'i'}[sw]
samples = struct.unpack('<%d%s' % (n * ch, fmt), data)
full = float(2 ** (8 * sw - 1))
print(f"{sys.argv[1]}: {n / sr:.2f} s, {ch} ch, {sr} Hz, {8 * sw}-bit")
for c in range(ch):
    s = samples[c::ch]
    rms = math.sqrt(sum(x * x for x in s) / max(1, len(s))) / full
    peak = max(abs(x) for x in s) / full
    db = lambda v: 20 * math.log10(v) if v > 0 else float('-inf')
    print(f"  ch{c}: rms {db(rms):6.1f} dBFS  peak {db(peak):6.1f} dBFS  {'(silence/dead)' if peak < 1e-4 else ''}")
