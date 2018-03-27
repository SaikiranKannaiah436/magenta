/**
 * @license
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
import * as dl from 'deeplearn';
import {INoteSequence, NoteSequence} from '@magenta/core';

export {INoteSequence};

const DEFAULT_DRUM_PITCH_CLASSES: number[][] = [
  // bass drum
  [36, 35],
  // snare drum
  [38, 27, 28, 31, 32, 33, 34, 37, 39, 40, 56, 65, 66, 75, 85],
  // closed hi-hat
  [42, 44, 54, 68, 69, 70, 71, 73, 78, 80],
  // open hi-hat
  [46, 67, 72, 74, 79, 81],
  // low tom
  [45, 29, 41, 61, 64, 84],
  // mid tom
  [48, 47, 60, 63, 77, 86, 87],
  // high tom
  [50, 30, 43, 62, 76, 83],
  // crash cymbal
  [49, 55, 57, 58],
  // ride cymbal
  [51, 52, 53, 59, 82]
];

/**
 * Interface for JSON specification of a `DataConverter`.
 *
 * @property type The name of the `DataConverter` class.
 * @property args Map containing values for argments to the constructor of the
 * `DataConverter` class specified above.
 */
export interface ConverterSpec {
  type: string;
  args: DrumsConverterArgs | MelodyConverterArgs;
}

/**
 * Builds a `DataConverter` based on the given `ConverterSpec`.
 *
 * @param spec Specifies the `DataConverter` to build.
 * @returns A new `DataConverter` object based on `spec`.
 * @throws Error if the specified type is not recognized.
 */
export function converterFromSpec(spec: ConverterSpec) {
  if (spec.type === 'MelodyConverter') {
    return new MelodyConverter(spec.args as MelodyConverterArgs);
  } else if (spec.type === 'DrumsConverter') {
    return new DrumsConverter(spec.args as DrumsConverterArgs);
  } else if (spec.type === 'DrumRollConverter') {
    return new DrumRollConverter(spec.args as DrumsConverterArgs);
  } else {
    throw new Error(
      'Unknown DataConverter type in spec: ' + spec.type);
  }
}

/**
 * Abstract DataConverter class for converting between `Tensor` and
 * `NoteSequence` objects.
 */
export abstract class DataConverter {
  abstract numSteps: number;  // Total length of sequences.
  abstract numSegments: number;  // Number of steps for conductor.
  abstract readonly NUM_SPLITS: number;  // Number of conductor splits.
  abstract toTensor(noteSequence: INoteSequence): dl.Tensor2D;
  abstract toNoteSequence(tensor: dl.Tensor2D): Promise<INoteSequence>;
}

/**
 * Converts between a quantized `NoteSequence` containing a drum sequence
 * and the `Tensor` objects used by `MusicVAE`.
 *
 * The `Tensor` output by `toTensor` is a 2D "drum roll" format. Each
 * row is a time step, and each column (up to the final) is a vector of Booleans
 * representing whether a drum from the associated pitch class is being hit at
 * that time. The final column is a Boolean computed by taking a NOR of the
 * other columns in the row.
 *
 * The expected `Tensor` in `toNoteSequence` is a one-hot encoding of labels
 * generated by converting the bit string from the input (excluding the final
 * bit) to an integer.
 *
 * The output `NoteSequence` uses quantized time and only the first pitch in
 * pitch class are used.
 *
 * @param numSteps The length of each sequence.
 * @param numSegments (Optional) The number of conductor segments, if
 * applicable.
 * @param pitchClasses (Optional) An array of arrays, grouping together MIDI
 * pitches to treat as the same drum. The first pitch in each class will be used
 * in the `NoteSequence` returned by `toNoteSequence`. A default mapping to 9
 * classes is used if not provided.
 */
export interface DrumsConverterArgs {
  numSteps: number;
  numSegments?: number;
  pitchClasses?: number[][];
}
export class DrumsConverter extends DataConverter{
  numSteps: number;
  numSegments: number;
  pitchClasses: number[][];
  pitchToClass: {[pitch: number] : number};
  NUM_SPLITS = 0;

  constructor(args: DrumsConverterArgs) {
    super();
    this.pitchClasses = (args.pitchClasses) ?
        args.pitchClasses : DEFAULT_DRUM_PITCH_CLASSES;
    this.numSteps = args.numSteps;
    this.numSegments = args.numSegments;
    this.pitchToClass = {};
    for (let c = 0; c < this.pitchClasses.length; ++c) {  // class
      this.pitchClasses[c].forEach((p) => {this.pitchToClass[p] = c;});
    }
  }

  toTensor(noteSequence: INoteSequence) {
    const drumRoll = dl.buffer([this.numSteps, this.pitchClasses.length + 1]);
    // Set final values to 1 and change to 0 later if the column gets a note.
    for (let i = 0; i < this.numSteps; ++i) {
      drumRoll.set(1, i, -1);
    }
    noteSequence.notes.forEach((note) => {
      drumRoll.set(1, note.quantizedStartStep, this.pitchToClass[note.pitch]);
      drumRoll.set(0, note.quantizedStartStep, -1);
    });
    return drumRoll.toTensor() as dl.Tensor2D;
  }

  async toNoteSequence(oh: dl.Tensor2D) {
    const noteSequence = NoteSequence.create();
    const labelsTensor = oh.argMax(1);
    const labels: Int32Array = await labelsTensor.data() as Int32Array;
    labelsTensor.dispose();
    for (let s = 0; s < labels.length; ++s) {  // step
      for (let p = 0; p < this.pitchClasses.length; p++) {  // pitch class
        if (labels[s] >> p & 1) {
          noteSequence.notes.push(
              NoteSequence.Note.create({
                pitch: this.pitchClasses[p][0],
                quantizedStartStep: s,
                quantizedEndStep: s + 1}));
        }
      }
    }
    return noteSequence;
  }
}

/**
 * Converts between a quantized `NoteSequence` containing a drum sequence
 * and the `Tensor` objects used by `MusicVAE`.
 *
 * The `Tensor` output by `toTensor` is the same 2D "drum roll" as in
 * `DrumsConverter`.
 *
 * The expected `Tensor` in `toNoteSequence` is the same as the "drum roll",
 * excluding the final NOR column.
 *
 * The output `NoteSequence` uses quantized time and only the first pitch in
 * pitch class are used.
 */
export class DrumRollConverter extends DrumsConverter {
  async toNoteSequence(roll: dl.Tensor2D) {
    const noteSequence = NoteSequence.create();
    for (let s = 0; s < roll.shape[0]; ++s) {  // step
      const rollSlice = roll.slice([s, 0], [1, roll.shape[1]]);
      const pitches = await rollSlice.data() as Uint8Array;
      rollSlice.dispose();
      for (let p = 0; p < pitches.length; ++p) {  // pitch class
        if (pitches[p]) {
          noteSequence.notes.push(
              NoteSequence.Note.create({
                pitch: this.pitchClasses[p][0],
                quantizedStartStep: s,
                quantizedEndStep: s + 1}));
        }
      }
    }
    return noteSequence;
  }
}

/**
 * Converts between a monophonic, quantized `NoteSequence` containing a melody
 * and the `Tensor` objects used by `MusicVAE`.
 *
 * Melodies are represented as a sequence of categorical variables, representing
 * one of three possible events:
 *   - A non-event, i.e. holding a note or resting. (0)
 *   - A note off. (1)
 *   - A note on with a specific pitch. (> 1)
 *
 * The `Tensor` output by `toTensor` is a one-hot encoding of the sequence of
 * labels extracted from the `NoteSequence`.
 *
 * The expected `Tensor` in `toNoteSequence` is a one-hot encoding of melody
 * sequence labels like those returned by `toTensor`.
 *
 * @param numSteps The length of each sequence.
 * @param minPitch The minimum pitch to model. Those above this value will
 * cause an errot to be thrown.
 * @param maxPitch The maximum pitch to model. Those above this value will
 * cause an error to be thrown.
 * @param numSegments (Optional) The number of conductor segments, if
 * applicable.
 */
export interface MelodyConverterArgs {
  numSteps: number;
  minPitch: number;
  maxPitch: number;
  numSegments?: number;
}
export class MelodyConverter extends DataConverter{
  numSteps: number;
  numSegments: number;
  minPitch: number;  // inclusive
  maxPitch: number;  // inclusive
  depth: number;
  NUM_SPLITS = 0;
  NOTE_OFF = 1;
  FIRST_PITCH = 2;

  constructor(args: MelodyConverterArgs) {
    super();
    this.numSteps = args.numSteps;
    this.numSegments = args.numSegments;
    this.minPitch = args.minPitch;
    this.maxPitch = args.maxPitch;
    this.depth = args.maxPitch - args.minPitch + 3;
  }

  toTensor(noteSequence: INoteSequence) {
    const sortedNotes: NoteSequence.INote[] = noteSequence.notes.sort(
      (n1, n2) => n1.quantizedStartStep - n2.quantizedStartStep);
    const mel = dl.buffer([this.numSteps]);
    let lastEnd = -1;
    sortedNotes.forEach(n => {
      if  (n.quantizedStartStep < lastEnd) {
        throw new Error('`NoteSequence` is not monophonic.');
      }
      if (n.pitch < this.minPitch || n.pitch > this.maxPitch) {
        throw Error(
          '`NoteSequence` has a pitch outside of the valid range: ' + n.pitch);
      }
      mel.set(n.pitch - this.minPitch + this.FIRST_PITCH, n.quantizedStartStep);
      mel.set(this.NOTE_OFF, n.quantizedEndStep);
      lastEnd = n.quantizedEndStep;
    });
    return dl.oneHot(
        mel.toTensor() as dl.Tensor1D, this.depth) as dl.Tensor2D;
  }

  async toNoteSequence(oh: dl.Tensor2D) {
    const noteSequence = NoteSequence.create();
    const labelsTensor = oh.argMax(1);
    const labels: Int32Array = await labelsTensor.data() as Int32Array;
    labelsTensor.dispose();
    let currNote: NoteSequence.Note = null;
    for (let s = 0; s < labels.length; ++s) {  // step
      const label = labels[s];
      switch (label) {
        case 0:
          break;
        case 1:
          if (currNote) {
            currNote.quantizedEndStep = s;
            noteSequence.notes.push(currNote);
            currNote = null;
          }
          break;
        default:
          if (currNote) {
            currNote.quantizedEndStep = s;
            noteSequence.notes.push(currNote);
          }
          currNote = NoteSequence.Note.create({
            pitch: label - this.FIRST_PITCH + this.minPitch,
            quantizedStartStep: s});
      }
    }
    if (currNote) {
      currNote.quantizedEndStep = labels.length;
      noteSequence.notes.push(currNote);
    }
    return noteSequence;
  }
}
