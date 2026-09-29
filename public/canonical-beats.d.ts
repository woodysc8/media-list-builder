export const CANONICAL_BEATS: string[];
export const GEOGRAPHIC_RAW_VALUES: string[];
export function normalizeRawBeat(value: unknown): string;
export function splitRawBeats(value: string | string[] | null | undefined): string[];
export function canonicalBeatsForRaw(value: string | string[] | null | undefined): string[];
export function rawBeatsForCanonical(value: string | string[] | null | undefined, selectedCanonicalBeat: string): string[];
export function hasRawBeatMappingForCanonical(selectedCanonicalBeat: string): boolean;
export function canonicalizeRawBeats(value: string | string[] | null | undefined): string;
export function planCanonicalBeatMigration(rows: string[][], header: string[]): {
  beatsIndex: number;
  originalIndex: number;
  rowsWithBeats: number;
  rowsWouldChange: number;
  rowsWithMultipleCanonicalCategories: number;
  rowsWithoutCanonicalMapping: number;
  unmappedRawBeats: Array<{ value: string; count: number }>;
  plannedRows: Array<{ rowNumber: number; raw: string; canonical: string; changeBeats: boolean; preserveOriginal: boolean }>;
  googleRowsWouldBeWritten: number;
};
