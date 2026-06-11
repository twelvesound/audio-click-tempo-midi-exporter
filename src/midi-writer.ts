export type MidiNoteEvent = {
  pitch: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
  /** MIDI note-off (release) velocity. Defaults to 64 when not provided. */
  offVelocity?: number;
};

export type MidiTrackData = {
  name: string;
  channel: number;
  notes: MidiNoteEvent[];
};

export type TempoEvent = {
  beat: number;
  bpm: number;
};

export type TimeSignatureEvent = {
  beat: number;
  numerator: number;
  denominator: number;
};

const PPQ = 480;

type TimedBytes = {
  tick: number;
  order: number;
  bytes: number[];
};

function u16(value: number) {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number) {
  return [
    (value >> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ];
}

function variableLength(value: number) {
  let buffer = value & 0x7f;

  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }

  const bytes: number[] = [];
  for (;;) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) {
      buffer >>= 8;
    } else {
      break;
    }
  }

  return bytes;
}

function textMeta(type: number, text: string) {
  const bytes = Array.from(Buffer.from(text, "utf8")) as number[];
  return [0xff, type, ...variableLength(bytes.length), ...bytes];
}

function makeChunk(id: string, data: number[]) {
  return Buffer.from([...Array.from(Buffer.from(id, "ascii")), ...u32(data.length), ...data]);
}

function ticks(beats: number) {
  return Math.max(0, Math.round(beats * PPQ));
}

function renderEvents(events: TimedBytes[]) {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
  const bytes: number[] = [];
  let previousTick = 0;

  sorted.forEach((event) => {
    bytes.push(...variableLength(event.tick - previousTick), ...event.bytes);
    previousTick = event.tick;
  });

  bytes.push(0x00, 0xff, 0x2f, 0x00);
  return bytes;
}

function tempoMeta(bpm: number) {
  const microsecondsPerQuarter = Math.round(60_000_000 / bpm);
  return [
    0xff,
    0x51,
    0x03,
    (microsecondsPerQuarter >> 16) & 0xff,
    (microsecondsPerQuarter >> 8) & 0xff,
    microsecondsPerQuarter & 0xff,
  ];
}

function denominatorPower(denominator: number) {
  return Math.max(0, Math.round(Math.log2(denominator)));
}

function timeSignatureMeta(event: TimeSignatureEvent) {
  return [
    0xff,
    0x58,
    0x04,
    clampMidiByte(event.numerator, 4),
    denominatorPower(event.denominator),
    0x18,
    0x08,
  ];
}

function makeTempoTrack(tempoEvents: TempoEvent[], timeSignatureEvents: TimeSignatureEvent[]) {
  const normalizedTempoEvents = tempoEvents.length > 0 ? tempoEvents : [{ beat: 0, bpm: 120 }];
  const normalizedTimeSignatureEvents =
    timeSignatureEvents.length > 0
      ? timeSignatureEvents
      : [{ beat: 0, numerator: 4, denominator: 4 }];

  return renderEvents([
    { tick: 0, order: 0, bytes: textMeta(0x03, "Tempo") },
    ...normalizedTempoEvents.map((event, index) => ({
      tick: ticks(event.beat),
      order: 1 + index,
      bytes: tempoMeta(event.bpm),
    })),
    ...normalizedTimeSignatureEvents.map((event, index) => ({
      tick: ticks(event.beat),
      order: 10_000 + index,
      bytes: timeSignatureMeta(event),
    })),
  ]);
}

function clampMidiByte(value: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.min(127, Math.round(value)));
}

function normalizeVelocity(value: number | undefined) {
  if (value === undefined) {
    return 100;
  }

  return value <= 1 ? clampMidiByte(value * 127, 100) : clampMidiByte(value, 100);
}

function normalizeOffVelocity(value: number | undefined) {
  if (value === undefined) {
    return 64;
  }

  return value <= 1 ? clampMidiByte(value * 127, 64) : clampMidiByte(value, 64);
}

function makeMusicTrack(track: MidiTrackData) {
  const channel = Math.max(0, Math.min(15, track.channel));
  const events: TimedBytes[] = [{ tick: 0, order: 0, bytes: textMeta(0x03, track.name) }];

  track.notes.forEach((note) => {
    const startTick = ticks(note.startBeat);
    const endTick = Math.max(startTick + 1, ticks(note.startBeat + note.durationBeats));
    const pitch = clampMidiByte(note.pitch, 60);
    const velocity = normalizeVelocity(note.velocity);
    const offVelocity = normalizeOffVelocity(note.offVelocity);

    events.push({
      tick: startTick,
      order: 2,
      bytes: [0x90 | channel, pitch, velocity],
    });
    events.push({
      tick: endTick,
      order: 1,
      bytes: [0x80 | channel, pitch, offVelocity],
    });
  });

  return renderEvents(events);
}

export function createStandardMidiFile(
  tempoEvents: TempoEvent[],
  timeSignatureEvents: TimeSignatureEvent[],
  tracks: MidiTrackData[],
) {
  const chunks = [
    makeChunk("MThd", [...u16(1), ...u16(tracks.length + 1), ...u16(PPQ)]),
    makeChunk("MTrk", makeTempoTrack(tempoEvents, timeSignatureEvents)),
    ...tracks.map((track) => makeChunk("MTrk", makeMusicTrack(track))),
  ];

  return Buffer.concat(chunks);
}
