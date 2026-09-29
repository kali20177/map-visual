import { VIEW_STATE_VERSION, type PersistedViewState } from './types';

/**
 * Per-map-file view state: the filter/sort/group/column setup the user left
 * behind, plus whether the raw text pane was open.
 *
 * This layer exists for what the webview cannot do on its own: the webview's
 * `setState` only lives as long as the webview, so closing the file or
 * restarting VS Code would drop everything. `workspaceState` keeps one entry
 * per file, replayed verbatim when that file is opened again — the host never
 * interprets the view blob (the webview validates it on restore).
 *
 * Writes are throttled: the webview pushes a new blob on every re-render (i.e.
 * on every keystroke in the filter box) and `Memento.update` reaches the disk,
 * so entries are merged in memory and flushed at most once per FLUSH_MS, with
 * a forced flush when a panel closes.
 */

/** The slice of `vscode.Memento` this module needs — keeps it testable without the vscode runtime. */
export interface KeyValueStore {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
}

export interface FileViewEntry {
    /** View blob for this file; null when absent or written by an older schema. */
    view: PersistedViewState | null;
    /** Whether the raw-map split pane was open (host-owned, kept out of the webview blob). */
    splitOn: boolean;
    /** Last write, used to evict the least recently used entries. */
    ts: number;
}

const KEY = 'mapvisual.viewState';
/** A workspace with hundreds of maps must not bloat workspaceState. */
const MAX_ENTRIES = 50;
const FLUSH_MS = 600;

export class ViewStateStore {
    private readonly entries: Record<string, FileViewEntry>;
    private dirty = false;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly store: KeyValueStore,
        private readonly flushDelayMs = FLUSH_MS,
    ) {
        this.entries = loadEntries(store.get<unknown>(KEY, {}));
    }

    get(uri: string): FileViewEntry | undefined {
        return this.entries[uri];
    }

    setView(uri: string, view: PersistedViewState): void {
        this.touch(uri).view = view;
        this.scheduleFlush();
    }

    setSplit(uri: string, splitOn: boolean): void {
        const existing = this.entries[uri];
        // "no entry yet, and off" and "already off" both mean there is nothing
        // to record — touching first would leave an entry that never flushes
        if ((!existing && !splitOn) || existing?.splitOn === splitOn) {
            return;
        }
        this.touch(uri).splitOn = splitOn;
        this.scheduleFlush();
    }

    /** Force the pending write out (panel closed, extension deactivating). */
    flush(): void {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        if (!this.dirty) {
            return;
        }
        this.dirty = false;
        void this.store.update(KEY, this.entries);
    }

    dispose(): void {
        this.flush();
    }

    private touch(uri: string): FileViewEntry {
        const existing = this.entries[uri];
        if (existing) {
            existing.ts = Date.now();
            return existing;
        }
        const entry: FileViewEntry = { view: null, splitOn: false, ts: Date.now() };
        this.entries[uri] = entry;
        this.evict();
        return entry;
    }

    private evict(): void {
        const keys = Object.keys(this.entries);
        if (keys.length <= MAX_ENTRIES) {
            return;
        }
        keys.sort((a, b) => (this.entries[a]?.ts ?? 0) - (this.entries[b]?.ts ?? 0));
        for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) {
            delete this.entries[key];
        }
    }

    private scheduleFlush(): void {
        this.dirty = true;
        if (this.timer !== undefined) {
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.flush();
        }, this.flushDelayMs);
        // never hold the extension host process open for a bookkeeping write
        this.timer.unref?.();
    }
}

/**
 * Read back what a previous session stored. Anything malformed is dropped
 * rather than trusted: this data comes from disk and may have been written by
 * an older build (the webview re-validates as well, but a broken entry should
 * never reach it).
 */
function loadEntries(raw: unknown): Record<string, FileViewEntry> {
    const out: Record<string, FileViewEntry> = {};
    if (!raw || typeof raw !== 'object') {
        return out;
    }
    for (const [uri, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') {
            continue;
        }
        const entry = value as Partial<FileViewEntry>;
        if (typeof entry.splitOn !== 'boolean' || typeof entry.ts !== 'number' || !Number.isFinite(entry.ts)) {
            continue;
        }
        const view = entry.view;
        const usable =
            view != null && typeof view === 'object' && (view as Partial<PersistedViewState>).v === VIEW_STATE_VERSION;
        // a schema bump keeps the split flag (host-owned) but discards the view blob
        out[uri] = { view: usable ? (view as PersistedViewState) : null, splitOn: entry.splitOn, ts: entry.ts };
    }
    return out;
}
