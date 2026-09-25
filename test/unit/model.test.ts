import { describe, expect, it } from 'vitest';
import {
    DEFAULT_UI_STATE,
    buildView,
    filterAndSort,
    flattenItems,
    formatAddr,
    formatBytes,
    groupKeyOf,
    toCsv,
    type UiState,
} from '../../src/webview/model';
import type { MapDocument, SymbolRecord } from '../../src/types';

function sym(partial: Partial<SymbolRecord>): SymbolRecord {
    return {
        name: 'sym',
        mangled: null,
        demangled: null,
        addr: 0,
        size: 1,
        kind: 'code',
        section: '.text',
        object: 'a.o',
        archive: null,
        member: null,
        lma: null,
        storage: ['flash'],
        status: 'kept',
        isFill: false,
        fromSectionName: false,
        isSystem: false,
        isLto: false,
        ...partial,
    };
}

function doc(symbols: SymbolRecord[]): MapDocument {
    return {
        format: 'gnu-ld',
        file: 'test.map',
        regions: [],
        symbols,
        totals: { flash: 0, ram: 0, keptCount: symbols.length, discardedCount: 0, fillTotal: 0, kindTotals: { code: 0, rodata: 0, data: 0, bss: 0, meta: 0, pad: 0, other: 0 }, regions: [] },
        warnings: [],
    };
}

const ui = (over: Partial<UiState> = {}): UiState => ({ ...DEFAULT_UI_STATE, kinds: { ...DEFAULT_UI_STATE.kinds }, ...over });

const SAMPLE = [
    sym({ name: '_ZN3app4mainEv', demangled: 'app::main()', size: 100, addr: 0x100, object: 'src/main.cpp.o' }),
    sym({ name: '_Z3fooi', demangled: 'foo(int)', size: 50, addr: 0x200, object: 'src/util.cpp.o' }),
    sym({ name: 'g_table', size: 200, kind: 'data', addr: 0x300, object: 'src/main.cpp.o' }),
    sym({ name: 'g_buf', size: 300, kind: 'bss', addr: 0x400, object: 'lib.a(b.o)', archive: 'lib.a', member: 'b.o' }),
    sym({ name: 'crt_row', size: 4, kind: 'code', addr: 0x500, object: 'crt0.o', isSystem: true }),
    sym({ name: '.text.unused', size: 10, kind: 'code', status: 'discarded', addr: 0 }),
];

describe('filterAndSort', () => {
    it('sorts by size descending by default and excludes discarded', () => {
        const rows = filterAndSort(doc(SAMPLE), ui());
        expect(rows.map((r) => r.sym.size)).toEqual([300, 200, 100, 50, 4]);
    });

    it('filters by text across mangled and demangled forms', () => {
        const byDemangled = filterAndSort(doc(SAMPLE), ui({ filterText: 'app::main' }));
        expect(byDemangled.length).toBe(1);
        const byMangled = filterAndSort(doc(SAMPLE), ui({ filterText: '_ZN3app4mainEv' }));
        expect(byMangled.length).toBe(1);
        const byObject = filterAndSort(doc(SAMPLE), ui({ filterText: 'util.cpp' }));
        expect(byObject.length).toBe(1);
    });

    it('applies kind and size filters and the system toggle', () => {
        const codeOnly = filterAndSort(doc(SAMPLE), ui({ kinds: { ...DEFAULT_UI_STATE.kinds, data: false, bss: false } }));
        expect(codeOnly.every((r) => r.sym.kind === 'code')).toBe(true);
        const noSystem = filterAndSort(doc(SAMPLE), ui({ hideSystem: true }));
        expect(noSystem.find((r) => r.sym.isSystem)).toBeUndefined();
        const minSize = filterAndSort(doc(SAMPLE), ui({ minSize: 64 }));
        expect(minSize.every((r) => r.sym.size >= 64 || r.sym.isFill)).toBe(true);
    });

    it('shows discarded rows only when toggled', () => {
        const withDiscarded = filterAndSort(doc(SAMPLE), ui({ showDiscarded: true }));
        expect(withDiscarded.find((r) => r.sym.status === 'discarded')).toBeDefined();
    });
});

describe('grouping', () => {
    it('groups by object with subtotals sorted by size', () => {
        const items = buildView(doc(SAMPLE), ui({ groupBy: 'object' }));
        const groups = items.filter((i): i is Extract<typeof i, { kind: 'group' }> => i.kind === 'group');
        expect(groups[0]!.label).toBe('lib.a › b.o'); // 300 B, biggest group first
        expect(groups[0]!.size).toBe(300);
        expect(groups[0]!.count).toBe(1);
        expect(groups[1]!.label).toBe('main.cpp.o');
        expect(groups[1]!.size).toBe(300);
        expect(groups[1]!.count).toBe(2);
    });

    it('uses archive›member labels for archive members', () => {
        expect(groupKeyOf(SAMPLE[3], 'object')).toBe('lib.a › b.o');
    });

    it('collapsing removes child rows from the flattened list', () => {
        const items = buildView(doc(SAMPLE), ui({ groupBy: 'object' }));
        const flatAll = flattenItems(items, new Set()).filter((e) => e.row).length;
        const flatCollapsed = flattenItems(items, new Set(['object:main.cpp.o'])).filter((e) => e.row).length;
        expect(flatAll).toBe(5);
        expect(flatCollapsed).toBe(3);
    });
});

describe('formatting + csv', () => {
    it('formats sizes and addresses', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1024)).toBe('1.00 K');
        expect(formatBytes(2048 * 1024)).toBe('2.00 M');
        expect(formatAddr(0x08000054)).toBe('0x08000054');
        expect(formatAddr(0x123456789abc)).toBe('0x0000123456789abc');
    });

    it('escapes CSV fields', () => {
        const csv = toCsv([{ sym: sym({ name: 'weird,name', object: 'a"b.o' }), display: 'weird,name', secondary: null }], true);
        expect(csv.split('\n')[1]).toContain('"weird,name"');
        expect(csv.split('\n')[1]).toContain('"a""b.o"');
    });
});
