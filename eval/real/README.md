# Real-voice recordings

The six audio clips in `eval/audio/` are synthesized with macOS `say`. They prove that the audio
path works; they say nothing about real people. This folder is for real recordings.

## Collecting them

1. Ask each person first. Tell them the recording is used to test speech-to-text and that, unless
   they say otherwise, it stays on this laptop. Recordings are gitignored (`eval/real/audio/`).
2. Send them [`SCRIPT.md`](SCRIPT.md). Ten short lines, about two minutes in total.
3. They record each line in Voice Memos (or any recorder) and send the files back. Some background
   noise is good: a fan, a kitchen, a running tap. That's closer to a shop floor than a quiet room.
4. Put the files in `eval/real/audio/`, named `<speaker>__<case id>.<m4a|wav|mp3|webm>`.

## Running them

```bash
PROVIDER=local npm run eval -- --real
```

Each recording runs as an extra case: the recording is the first turn, and the simulated
technician answers follow-ups as in the scripted eval. The summary adds a `real_voice` block with
per-speaker word error rate and outcomes, reported separately from the synthesized clips.

If someone agrees to have their recording published, it can be force-added with
`git add -f eval/real/audio/<file>`. Otherwise, publish only the numbers.
