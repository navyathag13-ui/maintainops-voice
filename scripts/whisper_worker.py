"""Long-running local STT worker for PROVIDER=local.

Loads the faster-whisper model once, then reads one JSON request per line on
stdin ({"id": ..., "path": ...}) and writes one JSON reply per line on stdout
({"id": ..., "text": ...} or {"id": ..., "error": ...}).
Usage: whisper_worker.py [model]
"""
import json
import sys

from faster_whisper import WhisperModel

PROMPT = "Maintenance log. Generator, water pump, air compressor, drive belts, oil filters, bearings, hydraulic hoses."

model = WhisperModel(sys.argv[1] if len(sys.argv) > 1 else "base.en", device="cpu", compute_type="int8")
print(json.dumps({"ready": True}), flush=True)

for line in sys.stdin:
    req = json.loads(line)
    try:
        segments, _ = model.transcribe(req["path"], language="en", initial_prompt=PROMPT)
        reply = {"id": req["id"], "text": " ".join(s.text.strip() for s in segments)}
    except Exception as exc:  # report and keep serving
        reply = {"id": req["id"], "error": str(exc)}
    print(json.dumps(reply), flush=True)
