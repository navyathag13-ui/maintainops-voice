#!/usr/bin/env bash
# Synthesizes the audio clips for the audio cases with macOS `say`.
# These are machine-generated speech, NOT human recordings: they test the
# audio path end to end, not real shop-floor speech.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p audio
for id in $(node -e 'for (const c of require("./cases.json")) if (["c01-clean-washer","c02-clean-pump","c08-ambiguous-generator","c13-short-belts","c15-missing-duration","c20-multi-issue"].includes(c.id)) console.log(c.id)'); do
  text=$(node -e "console.log(require('./cases.json').find(c => c.id === '$id').utterance)")
  say -v Samantha -o "audio/$id.aiff" "$text"
  afconvert -f WAVE -d LEI16@16000 "audio/$id.aiff" "audio/$id.wav"
  rm "audio/$id.aiff"
  echo "audio/$id.wav"
done
