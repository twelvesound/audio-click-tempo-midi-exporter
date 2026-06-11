# Audio Click Tempo MIDI Exporter

Ableton Live Extension that exports Arrangement MIDI clips as a multitrack Standard MIDI File using an audio click track as the tempo and meter source.

## Included Files

- `audio-click-tempo-midi-exporter.ablx` - the Ableton Live Extension package.
- `clips/Click for TempoDetection.alc` - the dedicated Drift click clip used for tempo and meter detection.

## Behavior

- Run from an Arrangement time selection on the audio click track.
- Renders the selected audio click range with `renderPreFxAudio()`.
- Detects click onsets and writes MIDI Tempo Events from the detected click intervals.
- Interpolates clicks across short detection gaps so the tempo and meter map stays aligned with the MIDI notes, and reports every interpolation as a warning.
- Detects the provided Drift preset's higher-pitched bar-start click and writes MIDI Time Signature Events at meter changes.
- Exports MIDI notes from all MIDI tracks whose Arrangement clips overlap the selected range.
- Uses the selected range start as MIDI beat 0.
- Writes a Type 1 Standard MIDI File with one MIDI file track per Live MIDI track.
- Exports note release velocities, and skips MIDI channel 10 (GM drums) when assigning channels.
- Expands looping MIDI clips across their visible Arrangement duration.
- Skips muted tracks, tracks muted via solo, muted clips, and muted notes.
- Writes a sidecar JSON analysis file (including all detected onsets and warnings) next to the MIDI export.

## Use

Install `audio-click-tempo-midi-exporter.ablx` in Live's Settings > Extensions.

Copy `clips/Click for TempoDetection.alc` into your Ableton User Library, or drag it directly into the Live Set. The clip uses Ableton Live's Drift device, so the receiving Live installation must include Drift.

1. Put `Click for TempoDetection.alc` in Arrangement View.
2. Select the audio click range you want to export.
3. Right-click the selected audio range.
4. Choose `Extensions > Export MIDI From Audio Click Tempo`.
5. For sixteenth-note clicks, keep `Clicks per beat` at `4`.

To detect the final meter change correctly, include the next bar-start click after the last bar you want to export.

### Settings

Settings are remembered between runs.

- **Clicks per beat** - how many audio clicks make up one beat (`4` for sixteenth-note clicks).
- **Min/Max BPM** - click intervals outside this range are skipped (and reported as warnings).
- **Peak threshold ratio** - lower values detect quieter clicks.
- **Tempo smoothing** - optional moving-median over the per-click BPM values (3/5/7 clicks). Reduces tempo event spam caused by render jitter, at the cost of exact per-click timing. `Off` keeps the raw per-click tempo map, which exactly matches the audio duration.
- **Tempo change threshold** - minimum BPM difference required to emit a new tempo event (default `0.01`).

The MIDI file is written to Ableton Live's Extension storage directory. On macOS this is usually under `~/Library/Application Support/Ableton/Extensions Data/audio-click-tempo-midi-exporter/`. The exact path is shown in Live's Extension log after export. A sidecar `.json` file is written to the same folder for checking the detected tempo and meter data, including the raw onset list and any warnings.

If the export finishes with warnings (interpolated or skipped clicks), a dialog summarizes them. Errors are also shown in a dialog instead of only being logged.

## Current Limitations

- MIDI CC, pitch bend, program changes, MPE, and automation are not exported.
- Notes are exported from Arrangement clips, not Session clips.
- Meter detection is tuned for the provided Drift click preset.
- 3/4 and 6/8 are both represented as 3 beats per bar.
- A meter change can only be detected when the next bar-start click is included in the selected range.
- Tempo and meter are detected from rendered audio clicks, so small timing fluctuations or false detections may occur depending on the selected range, click rendering, or unusual tempo/meter changes. Always check the exported MIDI in the receiving DAW.

## Distribution Notes

The included `.alc` is intended as a reproducible click source for this Extension. It depends on Ableton Live's built-in Drift device; it does not replace or redistribute Ableton Live itself.

## Development

This project depends on the Ableton Extensions SDK, which is **not** included in this repository (the SDK license does not permit redistribution). Download `extensions-sdk-<version>.zip` from the Ableton beta Centercode portal, extract it, and point the `file:` dependencies in `package.json` at the extracted `.tgz` files:

```jsonc
"dependencies": {
  "@ableton-extensions/sdk": "file:/path/to/extracted/ableton-extensions-sdk-1.0.0-beta.0.tgz"
},
"devDependencies": {
  "@ableton-extensions/cli": "file:/path/to/extracted/ableton-extensions-cli-1.0.0-beta.0.tgz",
  ...
}
```

Then:

```sh
npm install
npm run build
npm run package
```

## Changelog

### 0.2.0

- Click detection gaps are now interpolated instead of silently shifting the whole tempo/meter map; every interpolation and skipped interval is reported as a warning (dialog, log, and analysis JSON).
- Audio decoding rewritten as a single-pass decode (orders of magnitude faster on long selections); analysis yields to the event loop so the progress dialog stays responsive and cancellation works during analysis.
- Errors and warnings are shown in a dialog instead of only the Extension log.
- Cancelling the settings dialog now aborts cleanly instead of logging a JSON parse error.
- Optional tempo smoothing (moving median) and configurable tempo change threshold.
- Settings are persisted between runs.
- Removed the unsupported Live project folder copy option; exported files remain in the Extension storage directory.
- Note release velocities are exported; MIDI channel 10 (GM drums) is skipped when assigning channels.
- Settings dialog restyled to match Ableton's dark theme; added a Cancel button.
- Analysis JSON now includes the extension version, warnings, and the full onset list (time, strength, downbeat score, virtual flag).

### 0.1.0

- Initial release.
