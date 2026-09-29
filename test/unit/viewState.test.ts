import { describe, expect, it } from 'vitest';
import { ViewStateStore, type KeyValueStore } from '../../src/viewState';
import { VIEW_STATE_VERSION, type PersistedViewState, type UiState } from '../../src/types';

/** In-memory stand-in for vscode.Memento, counting writes so the throttle is observable. */
class FakeStore implements KeyValueStore {
    data: Record<string, unknown> = {};
    writes = 0;

    get<T>(key: string, defaultValue: T): T {
        return (this.data[key] as T | undefined) ?? defaultValue;
    }

    update(key: string, value: unknown): Thenable<void> {
        this.writes++;
        this.data[key] = value;
        return Promise.resolve();
    }
}

const ui: UiState = {
    sortKey: 'size',
    sortDir: 'desc',
    filterText: '-libgcc.a',
    kinds: { code: true, rodata: true, data: true, bss: true, meta: false, pad: true, other: true },
    minSize: 64,
    groupBy: 'outSection',
    demangle: true,
    hideSystem: false,
    showDiscarded: false,
};

const view = (over: Partial<PersistedViewState> = {}): PersistedViewState => ({
    v: VIEW_STATE_VERSION,
    ui,
    collapsed: ['outSection:.bss'],
    view: 'list',
    treemapGroupKey: null,
    cols: [6.8, 33, 5.6, 23.5, 23.4, 7.7],
    scrollTop: 480,
    selected: [3, 4],
    symbolCount: 172,
    ...over,
});

const URI = 'file:///w/firmware.map';
const OTHER = 'file:///w/other.map';

describe('ViewStateStore', () => {
    it('round-trips a view through the workspace store', () => {
        const fake = new FakeStore();
        const store = new ViewStateStore(fake);
        store.setView(URI, view());
        store.setSplit(URI, true);
        store.flush();

        const reopened = new ViewStateStore(fake);
        const entry = reopened.get(URI);
        expect(entry?.view?.ui.filterText).toBe('-libgcc.a');
        expect(entry?.view?.scrollTop).toBe(480);
        expect(entry?.view?.selected).toEqual([3, 4]);
        expect(entry?.splitOn).toBe(true);
    });

    it('keeps the split flag and the view blob independent', () => {
        const fake = new FakeStore();
        const store = new ViewStateStore(fake);
        store.setSplit(URI, true); // no view yet
        store.setView(URI, view());
        // a later view push must not clear the host-owned split flag, and vice versa
        store.setSplit(URI, false);
        expect(store.get(URI)?.view?.symbolCount).toBe(172);
        expect(store.get(URI)?.splitOn).toBe(false);
        expect(store.get(OTHER)).toBeUndefined();
    });

    it('drops a view written by an older schema but keeps the split flag', () => {
        const fake = new FakeStore();
        fake.data['mapvisual.viewState'] = {
            [URI]: { view: { ...view(), v: VIEW_STATE_VERSION + 1 }, splitOn: true, ts: 5 },
        };
        const entry = new ViewStateStore(fake).get(URI);
        expect(entry?.view).toBeNull();
        expect(entry?.splitOn).toBe(true);
    });

    it('ignores malformed entries instead of trusting them', () => {
        const fake = new FakeStore();
        fake.data['mapvisual.viewState'] = {
            [URI]: { view: view(), splitOn: 'yes', ts: 1 }, // splitOn is not a boolean
            [OTHER]: { view: view(), splitOn: false, ts: Number.NaN },
            'file:///w/good.map': { view: view(), splitOn: false, ts: 3 },
        };
        const store = new ViewStateStore(fake);
        expect(store.get(URI)).toBeUndefined();
        expect(store.get(OTHER)).toBeUndefined();
        expect(store.get('file:///w/good.map')?.view?.symbolCount).toBe(172);
    });

    it('tolerates a store that holds garbage or nothing at all', () => {
        const fake = new FakeStore();
        fake.data['mapvisual.viewState'] = 'not an object';
        expect(new ViewStateStore(fake).get(URI)).toBeUndefined();
    });

    it('evicts the least recently used entries beyond the cap', () => {
        const fake = new FakeStore();
        const store = new ViewStateStore(fake);
        for (let i = 0; i < 60; i++) {
            store.setView(`file:///w/map-${i}.map`, view({ symbolCount: i }));
        }
        store.flush();
        const persisted = fake.data['mapvisual.viewState'] as Record<string, unknown>;
        expect(Object.keys(persisted).length).toBe(50);
        // the oldest ones are gone, the newest are kept
        expect(persisted['file:///w/map-0.map']).toBeUndefined();
        expect(persisted['file:///w/map-59.map']).toBeDefined();
    });

    it('coalesces rapid writes and flushes on demand', async () => {
        const fake = new FakeStore();
        const store = new ViewStateStore(fake, 5);
        store.setView(URI, view({ scrollTop: 1 }));
        store.setView(URI, view({ scrollTop: 2 }));
        store.setView(URI, view({ scrollTop: 3 }));
        expect(fake.writes).toBe(0); // nothing written synchronously
        store.flush();
        expect(fake.writes).toBe(1);
        // the last push wins, not the first
        const persisted = fake.data['mapvisual.viewState'] as Record<string, { view: PersistedViewState }>;
        expect(persisted[URI]?.view.scrollTop).toBe(3);

        store.setView(URI, view({ scrollTop: 4 }));
        await new Promise((r) => setTimeout(r, 30));
        expect(fake.writes).toBe(2); // the timer flushed on its own
    });

    it('does not rewrite when nothing changed', () => {
        const fake = new FakeStore();
        const store = new ViewStateStore(fake);
        store.setSplit(URI, false); // nothing stored yet, and "off" is the default
        store.flush();
        expect(fake.writes).toBe(0);
        expect(store.get(URI)).toBeUndefined(); // and no dangling in-memory entry
        store.setSplit(URI, true);
        store.flush();
        expect(fake.writes).toBe(1);
        // re-asserting the same value must not queue another write
        store.setSplit(URI, true);
        store.flush();
        expect(fake.writes).toBe(1);
    });
});
