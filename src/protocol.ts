import type { MapDocument, PersistedViewState } from './types';
import type { DiffResult } from './types';

/** extension host → worker */
export type HostToWorker =
    | { type: 'parse'; path: string; demangle: boolean; formatOverride: 'auto' | 'gnu-ld' | 'lld' }
    | { type: 'diff'; pathA: string; pathB: string; demangle: boolean; formatOverride: 'auto' | 'gnu-ld' | 'lld' };

/** worker → extension host */
export type WorkerToHost =
    | { type: 'progress'; stage: string; pct: number }
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
