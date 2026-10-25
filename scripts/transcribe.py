"""Local speech-to-text for PROVIDER=local. Usage: transcribe.py <audio file> [model]"""
import sys

from faster_whisper import WhisperModel

path = sys.argv[1]
model_name = sys.argv[2] if len(sys.argv) > 2 else "base.en"
model = WhisperModel(model_name, device="cpu", compute_type="int8")
segments, _ = model.transcribe(
    path,
    language="en",
    # Same domain vocabulary hint the OpenAI path sends.
    initial_prompt="Maintenance log. Generator, water pump, air compressor, drive belts, oil filters, bearings, hydraulic hoses.",
)
print(" ".join(s.text.strip() for s in segments))
