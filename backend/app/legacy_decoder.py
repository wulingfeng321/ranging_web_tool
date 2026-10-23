r"""Verify an SD round and export its lossless stereo WAV, timing CSV and logs.
Usage: python tools/decode_capture.py X:\R000001 [--output destination]
Standard library only. Original RNG files are never changed.
"""
import argparse
import csv
import io
import json
from pathlib import Path
import re
import struct
import wave

SCHEMAS = {
    "trigger": ["tick_ms"],
    "event": ["event", "local_ns", "quality", "locked"],
    "clock": ["event", "master_ns", "origin", "offset", "slope"],
    "candidate": ["event", "index_zero_based", "pulse0_offset_ns", "pulse1_offset_ns", "pulse2_offset_ns", "quality"],
    "pair": ["event_a_id", "event_b_id", "a_master_ns", "b_master_ns", "outcome_1_ok_2_ambiguous",
             "reason", "best_ns", "runner_ns", "best_score", "runner_score", "best_span_ns", "runner_span_ns",
             "best_a", "best_b", "runner_a", "runner_b"],
    "wave_clock": ["period_ps", "origin_master_ns"],
    "ui": ["tick_ms", "page", "temperature_deci_c", "settings_revision"],
    "status": ["tick_ms", "events", "event_rx", "results", "ambiguous", "inconsistent", "distance_mm",
               "result_delta_us", "valid", "batch_stage", "batch_count", "batch_used", "batch_span_mm",
               "sync_error_ns", "sample_period_ps", "audio_drops", "audio_gaps", "audio_overruns",
               "unlocked_events", "distance_rejects", "cadence_rejects"],
    "dsp": ["tick_ms", "coarse_passed", "fail_pulse0", "fail_pulse1", "fail_pulse2", "gap_rejected",
            "signatures", "no_candidates", "candidate_overflow", "coarse_max", "pulse0_max", "pulse1_max",
            "pulse2_max", "gap_min_ratio"],
}


def fnv1a(data):
    value = 2166136261
    for byte in data:
        value = ((value ^ byte) * 16777619) & 0xffffffff
    return value


def parse(data):
    meta = json.loads(data[:4096].split(b"\0", 1)[0])
    if (meta["format"], meta["header_bytes"], meta["channels"], meta["sample_bytes"], meta["anchor_bytes"]) != ("RNG1", 4096, 2, 2, 24):
        raise ValueError("Unsupported capture format")
    pcm_end = 4096 + meta["frames"] * 4
    anchor_end = pcm_end + meta["anchor_count"] * 24
    if len(data) != anchor_end + meta["log_bytes"]:
        raise ValueError("Truncated or incorrectly sized capture")
    anchors = list(struct.iter_unpack("<QQII", data[pcm_end:anchor_end]))
    if sum(a[3] for a in anchors) != meta["frames"]:
        raise ValueError("PCM / anchor frame count mismatch")
    logs = list(csv.reader(io.StringIO(data[anchor_end:].decode("ascii"))))
    for row in logs:
        if not row or row[0] not in SCHEMAS or len(row) - 1 != len(SCHEMAS[row[0]]):
            raise ValueError(f"Unknown or truncated log record: {row}")
    return meta, data[4096:pcm_end], anchors, logs


def decode_round(folder, output):
    marker = (folder / "COMPLETE.TXT").read_text(encoding="ascii")
    expected = re.findall(r"([AB]) bytes=(\d+) fnv1a=([0-9A-Fa-f]{8})", marker)
    if not marker.startswith("RNG1 complete") or [x[0] for x in expected] != ["A", "B"]:
        raise ValueError("Missing or invalid completion marker; keep this round for recovery")
    verified = []
    for board, size, digest in expected:
        data = (folder / f"{board}.RNG").read_bytes()
        if len(data) != int(size) or fnv1a(data) != int(digest, 16):
            raise ValueError(f"{board}: file size / checksum mismatch")
        parsed = parse(data)
        if parsed[0]["board"] != board:
            raise ValueError(f"{board}: firmware role / file name mismatch")
        verified.append((board, parsed))
    output.mkdir(parents=True, exist_ok=True)
    for board, (meta, pcm, anchors, logs) in verified:
        (output / f"{board}.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        with wave.open(str(output / f"{board}.wav"), "wb") as wav:
            wav.setnchannels(2)
            wav.setsampwidth(2)
            wav.setframerate(meta["rate"])
            wav.writeframes(pcm)
        with (output / f"{board}_anchors.csv").open("w", newline="", encoding="utf-8") as file:
            writer = csv.writer(file)
            writer.writerow(["wav_frame_end", "absolute_sample_end", "local_anchor_ns", "audio_epoch", "block_frames"])
            position = 0
            for count, ns, epoch, frames in anchors:
                position += frames
                writer.writerow([position, count, ns, epoch, frames])
        for kind, schema in SCHEMAS.items():
            with (output / f"{board}_{kind}.csv").open("w", newline="", encoding="utf-8") as file:
                writer = csv.writer(file)
                writer.writerow(schema)
                writer.writerows(row[1:] for row in logs if row[0] == kind)
        (output / f"{board}_all.csv").write_text("\n".join(",".join(row) for row in logs) + "\n", encoding="utf-8")
        print(f"{board}: {meta['frames'] / meta['rate']:.3f} s, {len(logs)} log records, overflow={meta['log_overflow']}")
    print(f"Verified and exported: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    decode_round(args.folder, args.output or args.folder / "decoded")
