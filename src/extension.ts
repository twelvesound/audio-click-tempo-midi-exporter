import {
  AudioTrack,
  DataModelObject,
  MidiClip,
  MidiTrack,
  TakeLane,
  initialize,
  type ActivationContext,
  type ArrangementSelection,
  type NoteDescription,
} from "@ableton-extensions/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  createStandardMidiFile,
  type MidiNoteEvent,
  type MidiTrackData,
  type TempoEvent,
  type TimeSignatureEvent,
} from "./midi-writer.js";
import settingsDialog from "./settings-dialog.html";

const EXTENSION_VERSION = "0.2.0";
const API_VERSION = "1.0.0";
const COMMAND_ID = "audio-click-tempo-midi-exporter.export";
const MENU_TITLE = "Export MIDI From Audio Click Tempo";
const BEAT_EPSILON = 0.000001;
const SETTINGS_FILE = "settings.json";
const DECODE_CHUNK_FRAMES = 1_000_000;

type Settings = {
  clicksPerBeat: number;
  minBpm: number;
  maxBpm: number;
  sensitivity: number;
  /** Median window (in clicks) used to smooth per-click BPM. 1 = off. */
  tempoSmoothing: number;
  /** Minimum BPM difference required to emit a new tempo event. */
  tempoChangeThreshold: number;
  /** Copy the exported files into the Live project folder. */
  copyToProject: boolean;
};

const DEFAULT_SETTINGS: Settings = {
  clicksPerBeat: 4,
  minBpm: 40,
  maxBpm: 260,
  sensitivity: 0.25,
  tempoSmoothing: 1,
  tempoChangeThreshold: 0.01,
  copyToProject: false,
};

type WavInfo = {
  sampleRate: number;
  channelCount: number;
  audioFormat: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
  frameCount: number;
};

type DecodedAudio = {
  wav: WavInfo;
  /** Channel-averaged samples, one float per frame. */
  mono: Float32Array;
  /** Per-block (hopSize frames) absolute peak across channels. */
  blockPeaks: Float32Array;
  hopSize: number;
};

type Onset = {
  seconds: number;
  sample: number;
  strength: number;
  /** True when this click was interpolated to fill a detection gap. */
  virtual?: boolean;
  downbeatScore?: number;
  isDownbeat?: boolean;
};

type TempoPoint = {
  clickIndex: number;
  segmentStartBeat: number;
  timeSeconds: number;
  intervalSeconds: number;
  bpm: number;
  isDownbeat: boolean;
};

type MeterEstimate = {
  detected: boolean;
  clicksPerBar?: number;
  beatsPerBar?: number;
  downbeatClickIndices: number[];
  confidence: number;
};

type ClickAnalysis = {
  onsets: Onset[];
  tempoPoints: TempoPoint[];
  tempoEvents: TempoEvent[];
  timeSignatureEvents: TimeSignatureEvent[];
  meter: MeterEstimate;
  insertedClickCount: number;
  skippedIntervalCount: number;
  warnings: string[];
};

function assertArrangementSelection(value: unknown): ArrangementSelection {
  const selection = value as ArrangementSelection;
  if (
    typeof selection?.time_selection_start !== "number" ||
    typeof selection?.time_selection_end !== "number" ||
    !Array.isArray(selection?.selected_lanes)
  ) {
    throw new Error("Run this from an Arrangement time selection on the audio click track.");
  }

  if (selection.time_selection_end <= selection.time_selection_start) {
    throw new Error("Select a non-empty Arrangement time range.");
  }

  return selection;
}

function getSelectedAudioTrack(context: ReturnType<typeof initialize>, selection: ArrangementSelection) {
  const objects = selection.selected_lanes.map((handle) =>
    context.getObjectFromHandle(handle, DataModelObject),
  );
  const audioTrack = objects.find((object): object is AudioTrack<"1.0.0"> => object instanceof AudioTrack);

  if (audioTrack) {
    return audioTrack;
  }

  const audioTakeLane = objects.find(
    (object): object is TakeLane<"1.0.0"> =>
      object instanceof TakeLane && object.parent instanceof AudioTrack,
  );

  if (audioTakeLane?.parent instanceof AudioTrack) {
    return audioTakeLane.parent;
  }

  throw new Error("Select an audio track or audio take lane.");
}

/** Returns null when the user cancelled the dialog. */
function parseSettings(result: string): Settings | null {
  if (!result || result.trim() === "") {
    return null;
  }

  const parsed = JSON.parse(result) as Partial<Settings> | null;
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }

  const settings: Settings = {
    clicksPerBeat: Number(parsed.clicksPerBeat ?? DEFAULT_SETTINGS.clicksPerBeat),
    minBpm: Number(parsed.minBpm ?? DEFAULT_SETTINGS.minBpm),
    maxBpm: Number(parsed.maxBpm ?? DEFAULT_SETTINGS.maxBpm),
    sensitivity: Number(parsed.sensitivity ?? DEFAULT_SETTINGS.sensitivity),
    tempoSmoothing: Math.round(Number(parsed.tempoSmoothing ?? DEFAULT_SETTINGS.tempoSmoothing)),
    tempoChangeThreshold: Number(
      parsed.tempoChangeThreshold ?? DEFAULT_SETTINGS.tempoChangeThreshold,
    ),
    copyToProject: Boolean(parsed.copyToProject ?? DEFAULT_SETTINGS.copyToProject),
  };

  if (!Number.isFinite(settings.clicksPerBeat) || settings.clicksPerBeat < 1) {
    throw new Error("Clicks per beat must be 1 or greater.");
  }

  if (
    !Number.isFinite(settings.minBpm) ||
    !Number.isFinite(settings.maxBpm) ||
    settings.minBpm <= 0 ||
    settings.maxBpm <= settings.minBpm
  ) {
    throw new Error("BPM range is invalid.");
  }

  if (!Number.isFinite(settings.sensitivity) || settings.sensitivity <= 0) {
    throw new Error("Peak threshold ratio must be greater than 0.");
  }

  if (!Number.isFinite(settings.tempoSmoothing) || settings.tempoSmoothing < 1 || settings.tempoSmoothing > 99) {
    throw new Error("Tempo smoothing must be between 1 (off) and 99 clicks.");
  }

  if (!Number.isFinite(settings.tempoChangeThreshold) || settings.tempoChangeThreshold < 0) {
    throw new Error("Tempo change threshold must be 0 or greater.");
  }

  return settings;
}

async function loadStoredSettings(directory: string): Promise<Settings> {
  try {
    const raw = await fs.readFile(path.join(directory, SETTINGS_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveStoredSettings(directory: string, settings: Settings) {
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, SETTINGS_FILE), JSON.stringify(settings, null, 2));
  } catch (error) {
    console.warn(`Could not save settings: ${String(error)}`);
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function showErrorDialog(
  context: ReturnType<typeof initialize>,
  message: string,
  title = "Audio Click Tempo MIDI Exporter \u2014 export failed",
) {
  const html = `<!doctype html><html><head><meta charset="utf-8"/><style>
:root { --ableton-bg: #383838; --ableton-panel: #4E4E4E; --ableton-button: #FFA500; --ableton-text: #FFFFFF; --ableton-border: #2C2C2C; }
body { margin: 0; padding: 16px 18px; background: var(--ableton-panel); color: var(--ableton-text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; display: flex; flex-direction: column; height: calc(100vh - 32px); }
h3 { margin: 0 0 10px; font-size: 14px; }
pre { flex: 1; margin: 0 0 12px; padding: 10px; overflow: auto; white-space: pre-wrap; word-break: break-word; background: var(--ableton-bg); border: 1px solid var(--ableton-border); border-radius: 3px; font-size: 12px; }
button { align-self: flex-end; padding: 7px 16px; border: none; border-radius: 3px; background: var(--ableton-button); color: #000; font: inherit; font-weight: 700; cursor: pointer; }
</style><script>
function closeDialog() {
  var message = { method: "close_and_send", params: [""] };
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.live) {
    window.webkit.messageHandlers.live.postMessage(message);
  } else if (window.chrome && window.chrome.webview) {
    window.chrome.webview.postMessage(message);
  }
}
</script></head><body>
<h3>${escapeHtml(title)}</h3>
<pre>${escapeHtml(message)}</pre>
<button onclick="closeDialog()">OK</button>
</body></html>`;

  try {
    await context.ui.showModalDialog(`data:text/html,${encodeURIComponent(html)}`, 460, 240);
  } catch (error) {
    console.error(`Could not show error dialog: ${String(error)}`);
  }
}

function noteToEvents(clip: MidiClip<"1.0.0">, note: NoteDescription): MidiNoteEvent[] {
  if (note.muted || note.duration <= 0) {
    return [];
  }

  if (!clip.looping) {
    const event = trimEventToRange({
      pitch: note.pitch,
      startBeat: clip.startTime + note.startTime - clip.startMarker,
      durationBeats: note.duration,
      velocity: note.velocity ?? 100,
      offVelocity: note.releaseVelocity,
    }, clip.startTime, clip.endTime);

    return event ? [event] : [];
  }

  const loopLength = clip.loopEnd - clip.loopStart;
  if (loopLength <= BEAT_EPSILON) {
    return [];
  }

  const events: MidiNoteEvent[] = [];
  const noteEnd = note.startTime + note.duration;
  const preLoopEnd = Math.min(clip.loopStart, clip.endMarker);
  const preLoopStart = Math.max(clip.startMarker, 0);

  if (note.startTime < preLoopEnd && noteEnd > preLoopStart) {
    const preLoopEvent = trimEventToRange({
      pitch: note.pitch,
      startBeat: clip.startTime + Math.max(note.startTime, preLoopStart) - clip.startMarker,
      durationBeats: Math.min(noteEnd, preLoopEnd) - Math.max(note.startTime, preLoopStart),
      velocity: note.velocity ?? 100,
      offVelocity: note.releaseVelocity,
    }, clip.startTime, clip.endTime);

    if (preLoopEvent) {
      events.push(preLoopEvent);
    }
  }

  const loopedNoteStart = Math.max(note.startTime, clip.loopStart);
  const loopedNoteEnd = Math.min(noteEnd, clip.loopEnd);

  if (loopedNoteEnd <= loopedNoteStart + BEAT_EPSILON) {
    return events;
  }

  const loopedNoteOffset = loopedNoteStart - clip.loopStart;
  const loopedNoteDuration = loopedNoteEnd - loopedNoteStart;
  const visibleEndUnfolded = clip.startMarker + (clip.endTime - clip.startTime);
  const firstIteration =
    Math.floor((clip.startMarker - clip.loopStart - loopedNoteOffset) / loopLength) - 1;
  const lastIteration =
    Math.ceil((visibleEndUnfolded - clip.loopStart - loopedNoteOffset) / loopLength) + 1;

  for (let iteration = firstIteration; iteration <= lastIteration; iteration += 1) {
    const repeatedNoteStart = clip.loopStart + loopedNoteOffset + iteration * loopLength;

    if (
      repeatedNoteStart + loopedNoteDuration <= clip.startMarker + BEAT_EPSILON ||
      repeatedNoteStart >= visibleEndUnfolded - BEAT_EPSILON
    ) {
      continue;
    }

    const event = trimEventToRange({
      pitch: note.pitch,
      startBeat: clip.startTime + repeatedNoteStart - clip.startMarker,
      durationBeats: loopedNoteDuration,
      velocity: note.velocity ?? 100,
      offVelocity: note.releaseVelocity,
    }, clip.startTime, clip.endTime);

    if (event) {
      events.push(event);
    }
  }

  return events;
}

function trimEventToRange(
  event: MidiNoteEvent,
  rangeStartBeat: number,
  rangeEndBeat: number,
): MidiNoteEvent | null {
  const eventStart = Math.max(event.startBeat, rangeStartBeat);
  const eventEnd = Math.min(event.startBeat + event.durationBeats, rangeEndBeat);

  if (eventEnd <= eventStart + BEAT_EPSILON) {
    return null;
  }

  return {
    ...event,
    startBeat: eventStart,
    durationBeats: eventEnd - eventStart,
  };
}

/** Maps a zero-based track index to a MIDI channel, skipping channel 10 (GM drums). */
function channelForTrackIndex(index: number) {
  const channel = index % 15;
  return channel >= 9 ? channel + 1 : channel;
}

function collectMidiTracks(
  context: ReturnType<typeof initialize>,
  selectionStartBeat: number,
  selectionEndBeat: number,
): MidiTrackData[] {
  const midiTracks = context.application.song.tracks.filter(
    (track): track is MidiTrack<"1.0.0"> => track instanceof MidiTrack,
  );

  return midiTracks
    .filter((track) => !track.mute && !track.mutedViaSolo)
    .map((track, trackIndex) => {
      const clips = track.arrangementClips.filter(
        (clip): clip is MidiClip<"1.0.0"> =>
          clip instanceof MidiClip &&
          !clip.muted &&
          clip.endTime > selectionStartBeat &&
          clip.startTime < selectionEndBeat,
      );
      const notes = clips
        .flatMap((clip) => clip.notes.flatMap((note) => noteToEvents(clip, note)))
        .map((event) => trimEventToRange(event, selectionStartBeat, selectionEndBeat))
        .filter((event): event is MidiNoteEvent => event !== null)
        .map((event) => ({
          ...event,
          startBeat: event.startBeat - selectionStartBeat,
        }));

      return {
        name: track.name || `MIDI Track ${trackIndex + 1}`,
        channel: channelForTrackIndex(trackIndex),
        notes,
      };
    })
    .filter((track) => track.notes.length > 0);
}

function readAscii(bytes: Uint8Array, offset: number, length: number) {
  return Array.from(bytes.slice(offset, offset + length), (byte) => String.fromCharCode(byte)).join("");
}

function readWavInfo(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") {
    throw new Error("Rendered file is not a RIFF/WAVE file.");
  }

  let offset = 12;
  let audioFormat = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;

    if (chunkId === "fmt ") {
      audioFormat = view.getUint16(chunkDataOffset, true);
      channelCount = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
    } else if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataSize = Math.min(chunkSize, bytes.byteLength - chunkDataOffset);
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!sampleRate || !channelCount || !bitsPerSample || !dataOffset || !dataSize) {
    throw new Error("WAV fmt/data chunks were not found.");
  }

  if (![1, 3].includes(audioFormat)) {
    throw new Error(`Unsupported WAV format ${audioFormat}. Expected PCM or IEEE float.`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataSize / (bytesPerSample * channelCount));

  return {
    sampleRate,
    channelCount,
    audioFormat,
    bitsPerSample,
    dataOffset,
    dataSize,
    frameCount,
  };
}

function sampleReader(view: DataView, wav: WavInfo): (byteOffset: number) => number {
  if (wav.audioFormat === 3 && wav.bitsPerSample === 32) {
    return (offset) => view.getFloat32(offset, true);
  }

  if (wav.audioFormat === 1 && wav.bitsPerSample === 16) {
    return (offset) => view.getInt16(offset, true) / 32768;
  }

  if (wav.audioFormat === 1 && wav.bitsPerSample === 24) {
    return (offset) => {
      const raw =
        view.getUint8(offset) |
        (view.getUint8(offset + 1) << 8) |
        (view.getUint8(offset + 2) << 16);
      return (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608;
    };
  }

  if (wav.audioFormat === 1 && wav.bitsPerSample === 32) {
    return (offset) => view.getInt32(offset, true) / 2147483648;
  }

  throw new Error(`Unsupported WAV bit depth ${wav.bitsPerSample}.`);
}

/**
 * Decodes the WAV payload in a single pass: channel-averaged mono samples for
 * spectral analysis, plus per-block channel peaks for the onset envelope.
 * Yields to the event loop between chunks so the progress dialog stays
 * responsive and cancellation is honored.
 */
async function decodeAudio(bytes: Uint8Array, wav: WavInfo, signal?: AbortSignal): Promise<DecodedAudio> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = sampleReader(view, wav);
  const bytesPerSample = wav.bitsPerSample / 8;
  const frameBytes = wav.channelCount * bytesPerSample;
  const hopSize = Math.max(64, Math.round(wav.sampleRate / 400));
  const mono = new Float32Array(wav.frameCount);
  const blockPeaks = new Float32Array(Math.max(1, Math.ceil(wav.frameCount / hopSize)));

  for (let chunkStart = 0; chunkStart < wav.frameCount; chunkStart += DECODE_CHUNK_FRAMES) {
    signal?.throwIfAborted();
    const chunkEnd = Math.min(wav.frameCount, chunkStart + DECODE_CHUNK_FRAMES);

    for (let frame = chunkStart; frame < chunkEnd; frame += 1) {
      const frameOffset = wav.dataOffset + frame * frameBytes;
      let sum = 0;
      let peak = 0;

      for (let channel = 0; channel < wav.channelCount; channel += 1) {
        const value = read(frameOffset + channel * bytesPerSample);
        sum += value;
        const magnitude = Math.abs(value);
        if (magnitude > peak) {
          peak = magnitude;
        }
      }

      mono[frame] = sum / wav.channelCount;
      const block = (frame / hopSize) | 0;
      if (peak > blockPeaks[block]!) {
        blockPeaks[block] = peak;
      }
    }

    await yieldToEventLoop();
  }

  return { wav, mono, blockPeaks, hopSize };
}

function frequencyEnergy(audio: DecodedAudio, startSample: number, frequency: number) {
  const { mono, wav } = audio;
  const start = Math.max(0, Math.min(startSample, wav.frameCount - 1));
  const length = Math.min(Math.round(wav.sampleRate * 0.08), wav.frameCount - start);
  if (length <= 8) {
    return 0;
  }

  let real = 0;
  let imaginary = 0;

  for (let index = 0; index < length; index += 1) {
    const window =
      length > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (length - 1)) : 1;
    const sample = mono[start + index]! * window;
    const phase = (2 * Math.PI * frequency * index) / wav.sampleRate;
    real += sample * Math.cos(phase);
    imaginary -= sample * Math.sin(phase);
  }

  return real * real + imaginary * imaginary;
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
  return sorted[index]!;
}

function median(values: number[]) {
  return percentile(values, 0.5);
}

function buildPeakEnvelope(audio: DecodedAudio) {
  const { blockPeaks, hopSize, wav } = audio;
  const windowSize = Math.max(hopSize, Math.round(wav.sampleRate / 200));
  const blocksPerWindow = Math.max(1, Math.ceil(windowSize / hopSize));
  const envelope: number[] = new Array(blockPeaks.length);

  for (let index = 0; index < blockPeaks.length; index += 1) {
    let peak = 0;
    const end = Math.min(blockPeaks.length, index + blocksPerWindow);
    for (let block = index; block < end; block += 1) {
      const value = blockPeaks[block]!;
      if (value > peak) {
        peak = value;
      }
    }
    envelope[index] = peak;
  }

  return { envelope, hopSize };
}

function detectOnsets(audio: DecodedAudio, settings: Settings): Onset[] {
  const { envelope, hopSize } = buildPeakEnvelope(audio);
  const envelopeMedian = percentile(envelope, 0.5);
  const p95 = percentile(envelope, 0.95);
  const max = percentile(envelope, 0.999);
  const threshold = Math.max(0.002, envelopeMedian * 8, p95 * settings.sensitivity, max * 0.04);
  const releaseThreshold = threshold * 0.35;
  const shortestClickInterval = 60 / (settings.maxBpm * settings.clicksPerBeat);
  const minSeparationSeconds = Math.max(0.015, shortestClickInterval * 0.45);
  const raw: Onset[] = [];
  let inTrigger = false;
  let peakValue = 0;
  let peakIndex = 0;

  for (let index = 0; index < envelope.length; index += 1) {
    const value = envelope[index]!;

    if (!inTrigger && value >= threshold) {
      inTrigger = true;
      peakValue = value;
      peakIndex = index;
    } else if (inTrigger && value > peakValue) {
      peakValue = value;
      peakIndex = index;
    } else if (inTrigger && value <= releaseThreshold) {
      raw.push({
        seconds: (peakIndex * hopSize) / audio.wav.sampleRate,
        sample: peakIndex * hopSize,
        strength: peakValue,
      });
      inTrigger = false;
    }
  }

  if (inTrigger) {
    raw.push({
      seconds: (peakIndex * hopSize) / audio.wav.sampleRate,
      sample: peakIndex * hopSize,
      strength: peakValue,
    });
  }

  const deduped: Onset[] = [];
  for (const onset of raw) {
    const previous = deduped[deduped.length - 1];
    if (!previous || onset.seconds - previous.seconds >= minSeparationSeconds) {
      deduped.push(onset);
    } else if (onset.strength > previous.strength) {
      deduped[deduped.length - 1] = onset;
    }
  }

  return deduped;
}

/**
 * Detection gaps shift every later click index, which silently drags the whole
 * tempo/meter map away from the MIDI notes. When a click-to-click interval is
 * close to an integer multiple of the local median interval, insert evenly
 * spaced virtual clicks to keep the click indexing continuous.
 */
function fillMissedClicks(audio: DecodedAudio, onsets: Onset[]) {
  if (onsets.length < 3) {
    return { onsets, insertedClickCount: 0 };
  }

  const intervals = onsets.slice(1).map((onset, index) => onset.seconds - onsets[index]!.seconds);
  const medianInterval = median(intervals);

  if (medianInterval <= 0) {
    return { onsets, insertedClickCount: 0 };
  }

  const filled: Onset[] = [onsets[0]!];
  let insertedClickCount = 0;

  for (let index = 1; index < onsets.length; index += 1) {
    const previous = filled[filled.length - 1]!;
    const current = onsets[index]!;
    const gap = current.seconds - previous.seconds;
    const multiple = Math.round(gap / medianInterval);

    if (multiple >= 2 && Math.abs(gap / multiple - medianInterval) <= medianInterval * 0.15) {
      for (let step = 1; step < multiple; step += 1) {
        const seconds = previous.seconds + (gap * step) / multiple;
        filled.push({
          seconds,
          sample: Math.round(seconds * audio.wav.sampleRate),
          strength: 0,
          virtual: true,
        });
        insertedClickCount += 1;
      }
    }

    filled.push(current);
  }

  return { onsets: filled, insertedClickCount };
}

async function annotateDownbeats(audio: DecodedAudio, onsets: Onset[], signal?: AbortSignal) {
  if (onsets.length < 2) {
    return onsets;
  }

  const scored: Onset[] = [];
  const totalEnergies: number[] = [];
  for (let index = 0; index < onsets.length; index += 1) {
    if (index % 100 === 99) {
      signal?.throwIfAborted();
      await yieldToEventLoop();
    }

    const onset = onsets[index]!;
    const normalClickEnergy = frequencyEnergy(audio, onset.sample, 1050);
    const downbeatClickEnergy = frequencyEnergy(audio, onset.sample, 1562.5);
    const downbeatScore = Math.log10((downbeatClickEnergy + 1e-12) / (normalClickEnergy + 1e-12));
    scored.push({ ...onset, downbeatScore });
    totalEnergies.push(normalClickEnergy + downbeatClickEnergy);
  }

  // Silent or interpolated positions have near-zero energy in both bands,
  // which makes the energy ratio meaningless (log of ~1). Exclude them from
  // the threshold statistics and never mark them as downbeats.
  const energyFloor = median(totalEnergies.filter((energy) => energy > 0)) * 0.05;
  const hasSignal = totalEnergies.map((energy) => energy >= energyFloor && energy > 0);
  const scores = scored
    .map((onset) => onset.downbeatScore!)
    .filter((_, index) => hasSignal[index]);

  if (scores.length === 0) {
    return scored.map((onset) => ({ ...onset, isDownbeat: false }));
  }

  const lowMedian = median(scores);
  const highScore = Math.max(...scores);
  const threshold = lowMedian + Math.max(1, (highScore - lowMedian) * 0.5);

  return scored.map((onset, index) => ({
    ...onset,
    isDownbeat: Boolean(hasSignal[index]) && onset.downbeatScore! >= threshold,
  }));
}

function estimateMeter(onsets: Onset[], settings: Settings): MeterEstimate {
  const downbeatClickIndices = onsets
    .map((onset, index) => (onset.isDownbeat ? index : -1))
    .filter((index) => index >= 0);

  if (downbeatClickIndices.length < 2) {
    return {
      detected: false,
      downbeatClickIndices,
      confidence: 0,
    };
  }

  const downbeatIntervals = downbeatClickIndices
    .slice(1)
    .map((index, offset) => index - downbeatClickIndices[offset]!);
  const clicksPerBar = Math.round(median(downbeatIntervals));
  const beatsPerBar = Math.round(clicksPerBar / settings.clicksPerBeat);
  const intervalError =
    downbeatIntervals.reduce((sum, interval) => sum + Math.abs(interval - clicksPerBar), 0) /
    downbeatIntervals.length;
  const confidence = Math.max(0, Math.min(1, 1 - intervalError / Math.max(1, clicksPerBar)));

  return {
    detected: clicksPerBar > 0 && beatsPerBar > 0,
    clicksPerBar,
    beatsPerBar,
    downbeatClickIndices,
    confidence,
  };
}

function tempoPointsFromOnsets(onsets: Onset[], settings: Settings) {
  const minInterval = 60 / (settings.maxBpm * settings.clicksPerBeat);
  const maxInterval = 60 / (settings.minBpm * settings.clicksPerBeat);
  const points: TempoPoint[] = [];
  let skippedIntervalCount = 0;

  for (let index = 1; index < onsets.length; index += 1) {
    const previous = onsets[index - 1]!;
    const current = onsets[index]!;
    const intervalSeconds = current.seconds - previous.seconds;

    if (intervalSeconds < minInterval || intervalSeconds > maxInterval) {
      skippedIntervalCount += 1;
      continue;
    }

    points.push({
      clickIndex: index,
      segmentStartBeat: (index - 1) / settings.clicksPerBeat,
      timeSeconds: previous.seconds,
      intervalSeconds,
      bpm: 60 / (intervalSeconds * settings.clicksPerBeat),
      isDownbeat: Boolean(previous.isDownbeat),
    });
  }

  return { points, skippedIntervalCount };
}

/**
 * Applies a centered moving-median to per-click BPM values. Reduces tempo
 * event spam caused by render jitter at the cost of exact per-click timing.
 */
function smoothTempoPoints(points: TempoPoint[], windowClicks: number): TempoPoint[] {
  if (windowClicks <= 1 || points.length === 0) {
    return points;
  }

  const half = Math.floor(windowClicks / 2);
  return points.map((point, index) => {
    const start = Math.max(0, index - half);
    const end = Math.min(points.length, index + half + 1);
    const windowBpms = points.slice(start, end).map((other) => other.bpm);
    return { ...point, bpm: median(windowBpms) };
  });
}

function tempoEventsFromPoints(points: TempoPoint[], changeThreshold: number): TempoEvent[] {
  const events: TempoEvent[] = [];
  const threshold = Math.max(0.001, changeThreshold);

  for (const point of points) {
    const previous = events[events.length - 1];
    if (!previous || Math.abs(previous.bpm - point.bpm) >= threshold) {
      events.push({
        beat: point.segmentStartBeat,
        bpm: point.bpm,
      });
    }
  }

  return events;
}

function timeSignatureEventsFromDownbeats(
  onsets: Onset[],
  settings: Settings,
  fallbackMeter: MeterEstimate,
): TimeSignatureEvent[] {
  const downbeatClickIndices = onsets
    .map((onset, index) => (onset.isDownbeat ? index : -1))
    .filter((index) => index >= 0);
  const events: TimeSignatureEvent[] = [];

  for (let index = 0; index < downbeatClickIndices.length - 1; index += 1) {
    const currentDownbeat = downbeatClickIndices[index]!;
    const nextDownbeat = downbeatClickIndices[index + 1]!;
    const clicksInBar = nextDownbeat - currentDownbeat;
    const numerator = Math.round(clicksInBar / settings.clicksPerBeat);

    if (numerator <= 0) {
      continue;
    }

    const beat = events.length === 0 ? 0 : currentDownbeat / settings.clicksPerBeat;
    const previous = events[events.length - 1];

    if (!previous || previous.numerator !== numerator || previous.denominator !== 4) {
      events.push({ beat, numerator, denominator: 4 });
    }
  }

  if (events.length > 0) {
    return events;
  }

  if (!fallbackMeter.detected || !fallbackMeter.beatsPerBar) {
    return [{ beat: 0, numerator: 4, denominator: 4 }];
  }

  return [{ beat: 0, numerator: fallbackMeter.beatsPerBar, denominator: 4 }];
}

async function analyzeClick(
  bytes: Uint8Array,
  settings: Settings,
  signal?: AbortSignal,
): Promise<ClickAnalysis> {
  const wav = readWavInfo(bytes);
  const audio = await decodeAudio(bytes, wav, signal);
  const detected = detectOnsets(audio, settings);
  const { onsets: filledOnsets, insertedClickCount } = fillMissedClicks(audio, detected);
  const onsets = await annotateDownbeats(audio, filledOnsets, signal);

  if (onsets.length < 2) {
    throw new Error(
      "Not enough clicks were detected. " +
        "Check that the selection covers the click audio, or lower the peak threshold ratio.",
    );
  }

  const { points: rawTempoPoints, skippedIntervalCount } = tempoPointsFromOnsets(onsets, settings);
  if (rawTempoPoints.length === 0) {
    throw new Error("No valid tempo points were found inside the BPM range.");
  }

  const tempoPoints = smoothTempoPoints(rawTempoPoints, settings.tempoSmoothing);
  const meter = estimateMeter(onsets, settings);
  const tempoEvents = tempoEventsFromPoints(tempoPoints, settings.tempoChangeThreshold);
  const timeSignatureEvents = timeSignatureEventsFromDownbeats(onsets, settings, meter);
  const warnings: string[] = [];

  if (insertedClickCount > 0) {
    warnings.push(
      `Interpolated ${insertedClickCount} missed click(s). ` +
        "Verify the exported tempo map around the gaps listed in the analysis JSON.",
    );
  }

  if (skippedIntervalCount > 0) {
    warnings.push(
      `Skipped ${skippedIntervalCount} click interval(s) outside the ` +
        `${settings.minBpm}-${settings.maxBpm} BPM range. ` +
        "Beat positions after a skipped interval may drift; check the analysis JSON.",
    );
  }

  return {
    onsets,
    tempoPoints,
    tempoEvents,
    timeSignatureEvents,
    meter,
    insertedClickCount,
    skippedIntervalCount,
    warnings,
  };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function round(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

type ExportResult = {
  midiPath: string;
  analysisPath: string;
  projectMidiPath?: string;
  projectAnalysisPath?: string;
  clickAnalysis: ClickAnalysis;
  tracks: MidiTrackData[];
  warnings: string[];
};

export function activate(activation: ActivationContext) {
  const context = initialize(activation, API_VERSION);

  context.commands.registerCommand(COMMAND_ID, async (arg: unknown) => {
    try {
      const selection = assertArrangementSelection(arg);
      const clickTrack = getSelectedAudioTrack(context, selection);
      const storageDirectory = context.environment.storageDirectory;
      const storedSettings = storageDirectory
        ? await loadStoredSettings(storageDirectory)
        : { ...DEFAULT_SETTINGS };

      const dialogHtml = settingsDialog.replace(
        '"__DEFAULTS_JSON__"',
        JSON.stringify(storedSettings),
      );
      const dialogResult = await context.ui.showModalDialog(
        `data:text/html,${encodeURIComponent(dialogHtml)}`,
        440,
        540,
      );
      const settings = parseSettings(dialogResult);

      if (!settings) {
        console.log("Audio Click Tempo MIDI export cancelled.");
        return;
      }

      if (storageDirectory) {
        await saveStoredSettings(storageDirectory, settings);
      }

      const result = await context.ui.withinProgressDialog(
        "Exporting MIDI from audio click tempo...",
        { progress: 0 },
        async (update, signal) => {
          await update("Rendering click audio...", 10);
          const wavPath = await context.resources.renderPreFxAudio(
            clickTrack,
            selection.time_selection_start,
            selection.time_selection_end,
          );
          signal.throwIfAborted();

          await update("Analyzing tempo and meter...", 30);
          const clickAnalysis = await analyzeClick(
            new Uint8Array(await fs.readFile(wavPath)),
            settings,
            signal,
          );
          signal.throwIfAborted();

          await update("Collecting MIDI clips...", 65);
          const tracks = collectMidiTracks(
            context,
            selection.time_selection_start,
            selection.time_selection_end,
          );

          if (tracks.length === 0) {
            throw new Error("No Arrangement MIDI notes were found inside the selected range.");
          }

          await update("Writing MIDI file...", 80);
          const midi = createStandardMidiFile(
            clickAnalysis.tempoEvents,
            clickAnalysis.timeSignatureEvents,
            tracks,
          );
          const outputDirectory =
            context.environment.storageDirectory ?? context.environment.tempDirectory!;
          await fs.mkdir(outputDirectory, { recursive: true });
          const baseName = `audio-click-tempo-midi-${timestamp()}`;
          const midiPath = path.join(outputDirectory, `${baseName}.mid`);
          const analysisPath = path.join(outputDirectory, `${baseName}.json`);
          await fs.writeFile(midiPath, midi);
          await fs.writeFile(
            analysisPath,
            JSON.stringify(
              {
                extensionVersion: EXTENSION_VERSION,
                sourceClickTrack: clickTrack.name,
                selectionStartBeat: selection.time_selection_start,
                selectionEndBeat: selection.time_selection_end,
                settings,
                warnings: clickAnalysis.warnings,
                detectedClickCount: clickAnalysis.onsets.length,
                interpolatedClickCount: clickAnalysis.insertedClickCount,
                skippedIntervalCount: clickAnalysis.skippedIntervalCount,
                tempoEventCount: clickAnalysis.tempoEvents.length,
                timeSignatureEventCount: clickAnalysis.timeSignatureEvents.length,
                timeSignatureEvents: clickAnalysis.timeSignatureEvents,
                meter: clickAnalysis.meter,
                midiTrackCount: tracks.length,
                midiNoteCount: tracks.reduce((sum, track) => sum + track.notes.length, 0),
                tempoPoints: clickAnalysis.tempoPoints,
                onsets: clickAnalysis.onsets.map((onset) => ({
                  seconds: round(onset.seconds, 6),
                  strength: round(onset.strength, 4),
                  downbeatScore: onset.downbeatScore === undefined ? undefined : round(onset.downbeatScore, 3),
                  isDownbeat: onset.isDownbeat ?? false,
                  virtual: onset.virtual ?? false,
                })),
              },
              null,
              2,
            ),
          );

          const exportResult: ExportResult = {
            midiPath,
            analysisPath,
            clickAnalysis,
            tracks,
            warnings: [...clickAnalysis.warnings],
          };

          if (settings.copyToProject) {
            await update("Copying into the Live project...", 92);
            try {
              exportResult.projectMidiPath = await context.resources.importIntoProject(midiPath);
              exportResult.projectAnalysisPath =
                await context.resources.importIntoProject(analysisPath);
            } catch (error) {
              exportResult.warnings.push(
                `Could not copy the export into the Live project: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }

          await update("Done", 100);
          return exportResult;
        },
      ) as ExportResult;

      const bpms = result.clickAnalysis.tempoPoints.map((point) => point.bpm);
      console.log(
        `Exported Audio Click Tempo MIDI: ${result.midiPath} ` +
          `(${result.tracks.length} track(s), ${result.clickAnalysis.tempoEvents.length} tempo event(s), ` +
          `${result.clickAnalysis.timeSignatureEvents.length} time signature event(s), ` +
          `BPM ${Math.min(...bpms).toFixed(3)}-${Math.max(...bpms).toFixed(3)}).`,
      );
      if (result.projectMidiPath) {
        console.log(`Copied into the Live project: ${result.projectMidiPath}`);
      }
      if (result.clickAnalysis.meter.detected) {
        console.log(
          `Detected meter: ${result.clickAnalysis.meter.beatsPerBar}/4 ` +
            `(${result.clickAnalysis.meter.clicksPerBar} clicks/bar).`,
        );
      }
      console.log(`Audio click MIDI analysis JSON: ${result.analysisPath}`);

      for (const warning of result.warnings) {
        console.warn(warning);
      }

      if (result.warnings.length > 0) {
        await showErrorDialog(
          context,
          `Export finished with warnings:\n\n- ${result.warnings.join("\n- ")}\n\n` +
            `MIDI file: ${result.projectMidiPath ?? result.midiPath}`,
          "Audio Click Tempo MIDI Exporter \u2014 exported with warnings",
        );
      }
    } catch (error) {
      if (isAbortError(error)) {
        console.log("Audio Click Tempo MIDI export cancelled.");
        return;
      }

      console.error(error);
      await showErrorDialog(context, error instanceof Error ? error.message : String(error));
    }
  });

  context.ui.registerContextMenuAction(
    "AudioTrack.ArrangementSelection",
    MENU_TITLE,
    COMMAND_ID,
  );
}

/** Exposed for automated tests only. Not part of the extension API. */
export const __internals = {
  readWavInfo,
  decodeAudio,
  detectOnsets,
  fillMissedClicks,
  annotateDownbeats,
  estimateMeter,
  tempoPointsFromOnsets,
  smoothTempoPoints,
  tempoEventsFromPoints,
  timeSignatureEventsFromDownbeats,
  analyzeClick,
  parseSettings,
  channelForTrackIndex,
  DEFAULT_SETTINGS,
};
