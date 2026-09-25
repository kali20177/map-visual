import type { MapDocument } from './types';

/** extension host → worker */
export interface ParseRequest {
    path: string;
    demangle: boolean;
    formatOverride: 'auto' | 'gnu-ld' | 'lld';
}

/** worker → extension host */
export type ParseResponse =
    | { type: 'result'; doc: MapDocument }
    | { type: 'error'; error: { kind: 'notfound' | 'json' | 'unsupported' | 'unknown' | 'io'; message: string } };

/** extension host → webview */
export type HostToWebview =
    | { type: 'parseResult'; doc: MapDocument }
    | { type: 'parseError'; error: { kind: string; message: string } }
    | { type: 'parsing' };

/** webview → extension host */
export type WebviewToHost =
    | { type: 'ready' }
    | { type: 'exportCsv'; csv: string; suggestedName: string }
    | { type: 'openAsText' }
    | { type: 'revealObject'; object: string };
