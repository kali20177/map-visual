import { describe, expect, it } from 'vitest';
import {
    DEFAULT_UI_STATE,
    buildView,
    filterAndSort,
    flattenItems,
    formatAddr,
    formatBytes,
    groupKeyOf,
    parseFilterTerms,
    rowSetSignature,
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
        outSection: null,
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

    it('ANDs whitespace-separated terms', () => {
        const both = filterAndSort(doc(SAMPLE), ui({ filterText: 'main.cpp g_table' }));
        expect(both.map((r) => r.sym.name)).toEqual(['g_table']);
    });

    it('drops rows matching a -term', () => {
        const without = filterAndSort(doc(SAMPLE), ui({ filterText: '-main.cpp' }));
        expect(without.every((r) => !r.sym.object.includes('main.cpp'))).toBe(true);
        expect(without.length).toBe(3); // foo, g_buf, crt_row
    });
});

describe('parseFilterTerms', () => {
    it('splits on whitespace and lowercases', () => {
        expect(parseFilterTerms('  Main  UTIL ')).toEqual({ include: ['main', 'util'], exclude: [] });
    });

    it('treats a leading dash as exclusion', () => {
        expect(parseFilterTerms('-libc.a crt')).toEqual({ include: ['crt'], exclude: ['libc.a'] });
        expect(parseFilterTerms('-"linker stubs"')).toEqual({ include: [], exclude: ['linker stubs'] });
    });

    it('keeps quoted phrases together — paths and object names carry spaces', () => {
        expect(parseFilterTerms('"My Project/build/x.o"')).toEqual({ include: ['my project/build/x.o'], exclude: [] });
    });

    it('takes an unterminated quote to the end of the query', () => {
        expect(parseFilterTerms('-"half')).toEqual({ include: [], exclude: ['half'] });
        expect(parseFilterTerms('a "half')).toEqual({ include: ['a', 'half'], exclude: [] });
    });

    it('drops empty input and stray dashes', () => {
        expect(parseFilterTerms('   ')).toEqual({ include: [], exclude: [] });
        expect(parseFilterTerms('-')).toEqual({ include: [], exclude: [] });
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

    it('groups by output section, falling back to the input section when absent', () => {
        const syms = [
            sym({ name: 'a', section: '.text.a', outSection: '.text', size: 10 }),
            sym({ name: 'b', section: '.text.b', outSection: '.text', size: 5 }),
            sym({ name: 'c', section: '.rodata.c', outSection: '.rodata', size: 1 }),
            sym({ name: 'd', section: '.init', outSection: null, size: 2 }),
        ];
        expect(groupKeyOf(syms[0]!, 'outSection')).toBe('.text');
        expect(groupKeyOf(syms[3]!, 'outSection')).toBe('.init');
        // functions of the same output section collapse into one group
        const groups = buildView(doc(syms), ui({ groupBy: 'outSection' })).filter(
            (i): i is Extract<typeof i, { kind: 'group' }> => i.kind === 'group',
        );
        expect(groups.map((g) => g.label)).toEqual(['.text', '.init', '.rodata']); // size desc
        expect(groups[0]!.size).toBe(15);
        expect(groups[0]!.count).toBe(2);
    });

    it('collapsing removes child rows from the flattened list', () => {
        const items = buildView(doc(SAMPLE), ui({ groupBy: 'object' }));
        const flatAll = flattenItems(items, new Set()).filter((e) => e.row).length;
        const flatCollapsed = flattenItems(items, new Set(['object:main.cpp.o'])).filter((e) => e.row).length;
        expect(flatAll).toBe(5);
        expect(flatCollapsed).toBe(3);
    });
});

describe('rowSetSignature', () => {
    const base = (): UiState => ({ ...DEFAULT_UI_STATE, kinds: { ...DEFAULT_UI_STATE.kinds } });
    const sig = (ui: UiState, collapsed: string[] = [], epoch = 1): string => rowSetSignature(ui, collapsed, epoch);

    // The signature guards the row selection against drifting onto other
    // symbols, so the failure mode to prevent is "a ui field changed the row
    // list but not the signature" — this walks every field of the real object.
    it('changes when any UiState field changes', () => {
        const start = base();
        const startSig = sig(start);
        const fields = Object.keys(start) as Array<keyof UiState>;
        expect(fields.length).toBeGreaterThan(6); // sanity: the walk is not empty
        for (const key of fields) {
            const value = start[key];
            const mutated = {
                ...start,
                [key]:
                    typeof value === 'object'
                        ? { ...value, code: !value.code }
                        : typeof value === 'number'
                          ? value + 1
                          : typeof value === 'boolean'
                            ? !value
                            : `${value}-different`,
            } as UiState;
            expect(sig(mutated), `field "${key}" is not part of the signature`).not.toBe(startSig);
        }
    });

    it('changes with the collapsed groups and with a re-parse', () => {
        expect(sig(base(), ['object:a.o'])).not.toBe(sig(base(), ['object:b.o']));
        expect(sig(base(), [])).not.toBe(sig(base(), [], 2));
    });

    it('is stable regardless of key order', () => {
        const a = base();
        const reordered: Record<string, unknown> = {};
        for (const key of Object.keys(a).reverse()) {
            reordered[key] = (a as unknown as Record<string, unknown>)[key];
        }
        expect(sig(reordered as unknown as UiState)).toBe(sig(a));
        const kindsReordered = { ...a, kinds: Object.fromEntries(Object.entries(a.kinds).reverse()) as UiState['kinds'] };
        expect(sig(kindsReordered)).toBe(sig(a));
        expect(sig(base(), ['b', 'a'])).toBe(sig(base(), ['a', 'b']));
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
