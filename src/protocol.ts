import type { MapDocument, PersistedViewState } from './types';
import type { DiffResult } from './types';

/** extension host → worker */
export type HostToWorker =
    | { type: 'parse'; path: string; demangle: boolean; formatOverride: 'auto' | 'gnu-ld' | 'lld' }
    | { type: 'diff'; pathA: string; pathB: string; demangle: boolean; formatOverride: 'auto' | 'gnu-ld' | 'lld' };

/**
 * Parse stages, in order, plus the one step that only the diff job has.
 *
 * The worker reports these identifiers and the host renders them for the
 * progress notification (`hostI18n.ts`), so the union is what keeps a new stage
 * from showing up untranslated — and the CLI prints the raw value, which is why
 * the identifiers stay readable English.
 */
export const PROGRESS_STAGES = ['reading maps', 'detecting format', 'parsing symbols', 'demangling', 'analyzing regions', 'done'] as const;

export type ProgressStage = (typeof PROGRESS_STAGES)[number];

/** worker → extension host */
export type WorkerToHost =
    | {
          type: 'progress';
          stage: ProgressStage;
          pct: number;
          /** diff only: which map of the pair this stage belongs to. */
          side?: 'A' | 'B';
          /** diff only: the file being read, for the "reading maps" stage. */
          detail?: string;
      }
    | { type: 'result'; doc: MapDocument }
    | { type: 'diffResult'; diff: DiffResult }
    | { type: 'error'; error: { kind: 'notfound' | 'json' | 'unsupported' | 'unknown' | 'io'; message: string } };

/**
 * What a plain click on a symbol row does (`mapvisual.clickAction`).
 * Alt+click always performs the other one; double-click always locates.
 */
export type ClickAction = 'locate' | 'copy';

/** extension host → webview */
export type HostToWebview =
    | { type: 'settings'; clickAction: ClickAction }
    /** view state stored for this map file (workspaceState), replayed on every webview start */
    | { type: 'viewState'; state: PersistedViewState | null }
    | { type: 'parseResult'; doc: MapDocument }
    | { type: 'parseError'; error: { kind: string; message: string } }
    | { type: 'parseCancelled' }
    | { type: 'parsing' }
    | { type: 'diffResult'; diff: DiffResult }
    | { type: 'splitChanged'; on: boolean }
    | { type: 'rawLineMissing' };

/** webview → extension host */
export type WebviewToHost =
    | { type: 'ready' }
    | { type: 'persistView'; state: PersistedViewState }
    | { type: 'exportCsv'; csv: string; suggestedName: string; file?: string }
    | { type: 'openAsText' }
    | { type: 'revealSource'; object: string; member: string | null }
    | { type: 'toggleSplit' }
    | { type: 'revealRawLine'; line: number; name: string };

/** Legacy alias kept for the worker entry signature. */
export type ParseRequest = Extract<HostToWorker, { type: 'parse' }>;

/** Payload of a `progress` message, as handed to a job's reporter. */
export type ProgressEvent = Omit<Extract<WorkerToHost, { type: 'progress' }>, 'type'>;
