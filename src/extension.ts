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
import {
  createStandardMidiFile,
  type MidiNoteEvent,
  type MidiTrackData,
  type TempoEvent,
  type TimeSignatureEvent,
} from "./midi-writer.js";
import settingsDialog from "./settings-dialog.html";

const API_VERSION = "1.0.0";
const COMMAND_ID = "audio-click-tempo-midi-exporter.export";
const MENU_TITLE = "Export MIDI From Audio Click Tempo";
const BEAT_EPSILON = 0.000001;

type Settings = {
  clicksPerBeat: number;
  minBpm: number;
  maxBpm: number;
  sensitivity: number;
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

type Onset = {
  seconds: number;
  sample: number;
  strength: number;
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

function parseSettings(result: string): Settings {
  const parsed = JSON.parse(result) as Partial<Settings>;
  const settings = {
    clicksPerBeat: Number(parsed.clicksPerBeat ?? 4),
    minBpm: Number(parsed.minBpm ?? 40),
    maxBpm: Number(parsed.maxBpm ?? 260),
    sensitivity: Number(parsed.sensitivity ?? 0.25),
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

  return settings;
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
        channel: trackIndex % 16,
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
      dataSize = chunkSize;
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

function readSample(view: DataView, offset: number, audioFormat: number, bitsPerSample: number) {
  if (audioFormat === 3 && bitsPerSample === 32) {
    return view.getFloat32(offset, true);
  }

  if (audioFormat === 1 && bitsPerSample === 16) {
    return view.getInt16(offset, true) / 32768;
  }

  if (audioFormat === 1 && bitsPerSample === 24) {
    const raw =
      view.getUint8(offset) |
      (view.getUint8(offset + 1) << 8) |
      (view.getUint8(offset + 2) << 16);
    const signed = raw & 0x800000 ? raw | 0xff000000 : raw;
    return signed / 8388608;
  }

  if (audioFormat === 1 && bitsPerSample === 32) {
    return view.getInt32(offset, true) / 2147483648;
  }

  throw new Error(`Unsupported WAV bit depth ${bitsPerSample}.`);
}

function framePeak(bytes: Uint8Array, wav: WavInfo, frameIndex: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bytesPerSample = wav.bitsPerSample / 8;
  const frameOffset = wav.dataOffset + frameIndex * wav.channelCount * bytesPerSample;
  let peak = 0;

  for (let channel = 0; channel < wav.channelCount; channel += 1) {
    peak = Math.max(
      peak,
      Math.abs(readSample(view, frameOffset + channel * bytesPerSample, wav.audioFormat, wav.bitsPerSample)),
    );
  }

  return peak;
}

function monoSample(bytes: Uint8Array, wav: WavInfo, frameIndex: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bytesPerSample = wav.bitsPerSample / 8;
  const frameOffset = wav.dataOffset + frameIndex * wav.channelCount * bytesPerSample;
  let sum = 0;

  for (let channel = 0; channel < wav.channelCount; channel += 1) {
    sum += readSample(view, frameOffset + channel * bytesPerSample, wav.audioFormat, wav.bitsPerSample);
  }

  return sum / wav.channelCount;
}

function frequencyEnergy(bytes: Uint8Array, wav: WavInfo, startSample: number, frequency: number) {
  const length = Math.min(Math.round(wav.sampleRate * 0.08), wav.frameCount - startSample);
  if (length <= 8) {
    return 0;
  }

  let real = 0;
  let imaginary = 0;

  for (let index = 0; index < length; index += 1) {
    const window =
      length > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (length - 1)) : 1;
    const sample = monoSample(bytes, wav, startSample + index) * window;
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

function buildPeakEnvelope(bytes: Uint8Array, wav: WavInfo) {
  const hopSize = Math.max(64, Math.round(wav.sampleRate / 400));
  const windowSize = Math.max(hopSize, Math.round(wav.sampleRate / 200));
  const envelope: number[] = [];

  for (let frame = 0; frame < wav.frameCount; frame += hopSize) {
    let peak = 0;
    const end = Math.min(wav.frameCount, frame + windowSize);
    for (let index = frame; index < end; index += 1) {
      peak = Math.max(peak, framePeak(bytes, wav, index));
    }
    envelope.push(peak);
  }

  return { envelope, hopSize };
}

function detectOnsets(bytes: Uint8Array, wav: WavInfo, settings: Settings): Onset[] {
  const { envelope, hopSize } = buildPeakEnvelope(bytes, wav);
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
        seconds: (peakIndex * hopSize) / wav.sampleRate,
        sample: peakIndex * hopSize,
        strength: peakValue,
      });
      inTrigger = false;
    }
  }

  if (inTrigger) {
    raw.push({
      seconds: (peakIndex * hopSize) / wav.sampleRate,
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

function annotateDownbeats(bytes: Uint8Array, wav: WavInfo, onsets: Onset[]) {
  if (onsets.length < 2) {
    return onsets;
  }

  const scored = onsets.map((onset) => {
    const normalClickEnergy = frequencyEnergy(bytes, wav, onset.sample, 1050);
    const downbeatClickEnergy = frequencyEnergy(bytes, wav, onset.sample, 1562.5);
    const downbeatScore = Math.log10((downbeatClickEnergy + 1e-12) / (normalClickEnergy + 1e-12));
    return { ...onset, downbeatScore };
  });
  const scores = scored.map((onset) => onset.downbeatScore!);
  const lowMedian = median(scores);
  const highScore = Math.max(...scores);
  const threshold = lowMedian + Math.max(1, (highScore - lowMedian) * 0.5);

  return scored.map((onset) => ({
    ...onset,
    isDownbeat: onset.downbeatScore! >= threshold,
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

function tempoPointsFromOnsets(onsets: Onset[], settings: Settings): TempoPoint[] {
  const minInterval = 60 / (settings.maxBpm * settings.clicksPerBeat);
  const maxInterval = 60 / (settings.minBpm * settings.clicksPerBeat);
  const points: TempoPoint[] = [];

  for (let index = 1; index < onsets.length; index += 1) {
    const previous = onsets[index - 1]!;
    const current = onsets[index]!;
    const intervalSeconds = current.seconds - previous.seconds;

    if (intervalSeconds < minInterval || intervalSeconds > maxInterval) {
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

  return points;
}

function tempoEventsFromPoints(points: TempoPoint[]): TempoEvent[] {
  const events: TempoEvent[] = [];

  for (const point of points) {
    const previous = events[events.length - 1];
    if (!previous || Math.abs(previous.bpm - point.bpm) >= 0.001) {
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

function analyzeClick(bytes: Uint8Array, settings: Settings): ClickAnalysis {
  const wav = readWavInfo(bytes);
  const onsets = annotateDownbeats(bytes, wav, detectOnsets(bytes, wav, settings));
  if (onsets.length < 2) {
    throw new Error("Not enough clicks were detected.");
  }

  const tempoPoints = tempoPointsFromOnsets(onsets, settings);
  if (tempoPoints.length === 0) {
    throw new Error("No valid tempo points were found inside the BPM range.");
  }

  const meter = estimateMeter(onsets, settings);
  const tempoEvents = tempoEventsFromPoints(tempoPoints);
  const timeSignatureEvents = timeSignatureEventsFromDownbeats(onsets, settings, meter);

  return {
    onsets,
    tempoPoints,
    tempoEvents,
    timeSignatureEvents,
    meter,
  };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, API_VERSION);

  context.commands.registerCommand(COMMAND_ID, async (arg: unknown) => {
    try {
      const selection = assertArrangementSelection(arg);
      const clickTrack = getSelectedAudioTrack(context, selection);
      const dialogResult = await context.ui.showModalDialog(
        `data:text/html,${encodeURIComponent(settingsDialog)}`,
        420,
        300,
      );
      const settings = parseSettings(dialogResult);

      const result = await context.ui.withinProgressDialog(
        "Exporting MIDI from audio click tempo...",
        { progress: 0 },
        async (update, signal) => {
          await update("Rendering click audio...", 15);
          const wavPath = await context.resources.renderPreFxAudio(
            clickTrack,
            selection.time_selection_start,
            selection.time_selection_end,
          );
          signal.throwIfAborted();

          await update("Analyzing tempo and meter...", 40);
          const clickAnalysis = analyzeClick(new Uint8Array(await fs.readFile(wavPath)), settings);

          await update("Collecting MIDI clips...", 65);
          const tracks = collectMidiTracks(
            context,
            selection.time_selection_start,
            selection.time_selection_end,
          );

          if (tracks.length === 0) {
            throw new Error("No Arrangement MIDI notes were found inside the selected range.");
          }

          await update("Writing MIDI file...", 85);
          const midi = createStandardMidiFile(
            clickAnalysis.tempoEvents,
            clickAnalysis.timeSignatureEvents,
            tracks,
          );
          const outputDirectory =
            context.environment.storageDirectory ?? context.environment.tempDirectory!;
          const baseName = `audio-click-tempo-midi-${timestamp()}`;
          const midiPath = path.join(outputDirectory, `${baseName}.mid`);
          const analysisPath = path.join(outputDirectory, `${baseName}.json`);
          await fs.writeFile(midiPath, midi);
          await fs.writeFile(
            analysisPath,
            JSON.stringify(
              {
                sourceClickTrack: clickTrack.name,
                selectionStartBeat: selection.time_selection_start,
                selectionEndBeat: selection.time_selection_end,
                settings,
                detectedClickCount: clickAnalysis.onsets.length,
                tempoEventCount: clickAnalysis.tempoEvents.length,
                timeSignatureEventCount: clickAnalysis.timeSignatureEvents.length,
                timeSignatureEvents: clickAnalysis.timeSignatureEvents,
                meter: clickAnalysis.meter,
                midiTrackCount: tracks.length,
                midiNoteCount: tracks.reduce((sum, track) => sum + track.notes.length, 0),
                tempoPoints: clickAnalysis.tempoPoints,
              },
              null,
              2,
            ),
          );

          await update("Done", 100);
          return { midiPath, analysisPath, clickAnalysis, tracks };
        },
      ) as {
        midiPath: string;
        analysisPath: string;
        clickAnalysis: ClickAnalysis;
        tracks: MidiTrackData[];
      };

      const bpms = result.clickAnalysis.tempoPoints.map((point) => point.bpm);
      console.log(
        `Exported Audio Click Tempo MIDI: ${result.midiPath} ` +
          `(${result.tracks.length} track(s), ${result.clickAnalysis.tempoEvents.length} tempo event(s), ` +
          `${result.clickAnalysis.timeSignatureEvents.length} time signature event(s), ` +
          `BPM ${Math.min(...bpms).toFixed(3)}-${Math.max(...bpms).toFixed(3)}).`,
      );
      if (result.clickAnalysis.meter.detected) {
        console.log(
          `Detected meter: ${result.clickAnalysis.meter.beatsPerBar}/4 ` +
            `(${result.clickAnalysis.meter.clicksPerBar} clicks/bar).`,
        );
      }
      console.log(`Audio click MIDI analysis JSON: ${result.analysisPath}`);
    } catch (error) {
      console.error(error);
    }
  });

  context.ui.registerContextMenuAction(
    "AudioTrack.ArrangementSelection",
    MENU_TITLE,
    COMMAND_ID,
  );
}
