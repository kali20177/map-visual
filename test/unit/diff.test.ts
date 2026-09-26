import { describe, expect, it } from 'vitest';
import { diffDocuments } from '../../src/analysis/diff';
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

function doc(file: string, symbols: SymbolRecord[]): MapDocument {
    return {
        format: 'gnu-ld',
        file,
        regions: [],
        symbols,
        totals: { flash: 0, ram: 0, keptCount: symbols.length, discardedCount: 0, fillTotal: 0, kindTotals: { code: 0, rodata: 0, data: 0, bss: 0, meta: 0, pad: 0, other: 0 }, regions: [] },
        warnings: [],
    };
}

describe('diffDocuments', () => {
    it('classifies added / removed / changed / same rows', () => {
        const a = doc('a.map', [
            sym({ name: 'grew', size: 10 }),
            sym({ name: 'shrank', size: 50 }),
            sym({ name: 'gone', size: 20 }),
            sym({ name: 'stable', size: 7 }),
        ]);
        const b = doc('b.map', [
            sym({ name: 'grew', size: 30 }),
            sym({ name: 'shrank', size: 10 }),
            sym({ name: 'new', size: 5 }),
            sym({ name: 'stable', size: 7 }),
        ]);
        const d = diffDocuments(a, b);
        const byName = Object.fromEntries(d.rows.map((r) => [r.name, r]));
        expect(byName['grew']).toMatchObject({ status: 'changed', delta: 20 });
        expect(byName['shrank']).toMatchObject({ status: 'changed', delta: -40 });
        expect(byName['gone']).toMatchObject({ status: 'removed', sizeB: 0, delta: -20 });
        expect(byName['new']).toMatchObject({ status: 'added', sizeA: 0, delta: 5 });
        expect(byName['stable']).toMatchObject({ status: 'same', delta: 0 });
    });

    it('aggregates the same symbol across objects before comparing', () => {
        const a = doc('a.map', [
            sym({ name: '_Z1fv', demangled: 'f()', size: 10, object: 'x.o' }),
            sym({ name: '_Z1fv', demangled: 'f()', size: 10, object: 'y.o' }),
        ]);
        const b = doc('b.map', [sym({ name: '_Z1fv', demangled: 'f()', size: 15, object: 'x.o' })]);
        const d = diffDocuments(a, b);
        expect(d.rows.length).toBe(1);
        expect(d.rows[0]).toMatchObject({ status: 'changed', sizeA: 20, sizeB: 15, delta: -5 });
        expect(d.rows[0].objectA).toBe('x.o, y.o');
    });

    it('matches by mangled name even when only the demangled text differs', () => {
        const a = doc('a.map', [sym({ name: 'util::add3(int, int, int)', mangled: '_ZN4util4add3Eiii', size: 8 })]);
        const b = doc('b.map', [sym({ name: '_ZN4util4add3Eiii', size: 8 })]);
        const d = diffDocuments(a, b);
        expect(d.rows.length).toBe(1);
        expect(d.rows[0].status).toBe('same');
    });

    it('excludes discarded rows and fill padding from the diff', () => {
        const a = doc('a.map', [
            sym({ name: 'f', size: 10 }),
            sym({ name: '.text.unused', size: 5, status: 'discarded' }),
            sym({ name: '*fill*', size: 2, isFill: true, kind: 'pad' }),
        ]);
        const b = doc('b.map', [sym({ name: 'f', size: 10 })]);
        const d = diffDocuments(a, b);
        expect(d.rows.length).toBe(1);
        expect(d.rows[0].status).toBe('same');
    });

    it('sorts by impact (|delta| desc), added before removed', () => {
        const a = doc('a.map', [sym({ name: 'big', size: 100 })]);
        const b = doc('b.map', [
            sym({ name: 'added1', size: 60 }),
            sym({ name: 'added2', size: 30 }),
            sym({ name: 'stable', size: 5 }),
        ]);
        const d = diffDocuments(a, b);
        expect(d.rows.map((r) => r.name)).toEqual(['big', 'added1', 'added2', 'stable']);
    });
});
