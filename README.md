# Audio Click Tempo MIDI Exporter

Ableton Live Extension that exports Arrangement MIDI clips as a multitrack Standard MIDI File using an audio click track as the tempo and meter source.

## Included Files

- `audio-click-tempo-midi-exporter.ablx` - the Ableton Live Extension package.
- `clips/Click for TempoDetection.alc` - the dedicated Drift click clip used for tempo and meter detection.

## Behavior

- Run from an Arrangement time selection on the audio click track.
- Renders the selected audio click range with `renderPreFxAudio()`.
- Detects click onsets and writes MIDI Tempo Events from the detected click intervals.
- Detects the provided Drift preset's higher-pitched bar-start click and writes MIDI Time Signature Events at meter changes.
- Exports MIDI notes from all MIDI tracks whose Arrangement clips overlap the selected range.
- Uses the selected range start as MIDI beat 0.
- Writes a Type 1 Standard MIDI File with one MIDI file track per Live MIDI track.
- Expands looping MIDI clips across their visible Arrangement duration.
- Skips muted tracks, tracks muted via solo, muted clips, and muted notes.
- Writes a sidecar JSON analysis file next to the MIDI export.

## Use

Install `audio-click-tempo-midi-exporter.ablx` in Live's Settings > Extensions.

Copy `clips/Click for TempoDetection.alc` into your Ableton User Library, or drag it directly into the Live Set. The clip uses Ableton Live's Drift device, so the receiving Live installation must include Drift.

1. Put `Click for TempoDetection.alc` in Arrangement View.
2. Select the audio click range you want to export.
3. Right-click the selected audio range.
4. Choose `Extensions > Export MIDI From Audio Click Tempo`.
5. For sixteenth-note clicks, keep `Clicks per beat` at `4`.

To detect the final meter change correctly, include the next bar-start click after the last bar you want to export.

The exported file path is printed to the extension log:

```txt
Exported Audio Click Tempo MIDI: /Users/yourname/.../Audio Click Tempo MIDI Exporter/audio-click-tempo-midi-2026-06-10T00-00-00-000Z.mid
Audio click MIDI analysis JSON: /Users/yourname/.../Audio Click Tempo MIDI Exporter/audio-click-tempo-midi-2026-06-10T00-00-00-000Z.json
```

The MIDI file is written to Ableton Live's Extension storage directory, not to the current Live Project folder or the Desktop. The exact macOS path is shown in Live's Extension log after export. A sidecar `.json` file is written to the same folder for checking the detected tempo and meter data.

## Current Limitations

- MIDI CC, pitch bend, program changes, MPE, and automation are not exported.
- Notes are exported from Arrangement clips, not Session clips.
- Meter detection is tuned for the provided Drift click preset.
- 3/4 and 6/8 are both represented as 3 beats per bar in this first version.
- A meter change can only be detected when the next bar-start click is included in the selected range.
- Tempo and meter are detected from rendered audio clicks, so small timing fluctuations or false detections may occur depending on the selected range, click rendering, or unusual tempo/meter changes. Always check the exported MIDI in the receiving DAW.

## Distribution Notes

The included `.alc` is intended as a reproducible click source for this Extension. It depends on Ableton Live's built-in Drift device; it does not replace or redistribute Ableton Live itself.

## Development

```sh
npm install
npm run build
npm run package
```
