import type { MapDocument } from './types';
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

/** extension host → webview */
export type HostToWebview =
    | { type: 'parseResult'; doc: MapDocument }
    | { type: 'parseError'; error: { kind: string; message: string } }
    | { type: 'parseCancelled' }
    | { type: 'parsing' }
    | { type: 'diffResult'; diff: DiffResult };

/** webview → extension host */
export type WebviewToHost =
    | { type: 'ready' }
    | { type: 'exportCsv'; csv: string; suggestedName: string; file?: string }
    | { type: 'openAsText' }
    | { type: 'revealSource'; object: string; member: string | null };

/** Legacy alias kept for the worker entry signature. */
export type ParseRequest = Extract<HostToWorker, { type: 'parse' }>;
