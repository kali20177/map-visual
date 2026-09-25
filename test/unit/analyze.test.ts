import { describe, expect, it } from 'vitest';
import { assignRegionRoles, computeStorageAndTotals } from '../../src/analysis/analyze';
import type { MapDocument, MemoryRegion, SymbolRecord } from '../../src/types';

function region(name: string, origin: number, length: number): MemoryRegion {
    return { name, origin, length, attrs: '', role: 'other' };
}

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
        storage: [],
        status: 'kept',
        isFill: false,
        fromSectionName: false,
        isSystem: false,
        isLto: false,
        ...partial,
    };
}

describe('region role assignment', () => {
    it('anchors roles on the first code and bss symbols', () => {
        const regions = [region('A', 0x08000000, 0x10000), region('B', 0x20000000, 0x5000)];
        assignRegionRoles(regions, [
            sym({ addr: 0x08000100, kind: 'code' }),
            sym({ addr: 0x20000100, kind: 'bss' }),
        ]);
        expect(regions[0].role).toBe('flash');
        expect(regions[1].role).toBe('ram');
    });

    it('falls back to conventional names for unanchored regions', () => {
        const regions = [region('m_data', 0x20000000, 0x5000), region('ITCM', 0x00000000, 0x8000), region('WEIRD', 0x40000000, 0x1000)];
        assignRegionRoles(regions, []);
        expect(regions[0].role).toBe('ram');
        expect(regions[1].role).toBe('flash');
        expect(regions[2].role).toBe('other');
    });
});

describe('storage + totals', () => {
    it('counts .data once in flash and once in ram', () => {
        const doc = {
            format: 'lld',
            file: 't',
            regions: [],
            symbols: [
                sym({ name: 'f', kind: 'code', size: 10 }),
                sym({ name: 'r', kind: 'rodata', size: 5 }),
                sym({ name: 'd', kind: 'data', size: 8 }),
                sym({ name: 'b', kind: 'bss', size: 4 }),
                sym({ name: 'x', kind: 'meta', size: 3 }),
            ],
            totals: { flash: 0, ram: 0, keptCount: 0, discardedCount: 0, fillTotal: 0, kindTotals: { code: 0, rodata: 0, data: 0, bss: 0, meta: 0, pad: 0, other: 0 }, regions: [] },
            warnings: [],
        } as MapDocument;
        const totals = computeStorageAndTotals(doc);
        // meta is non-alloc → no storage; flash = code 10 + rodata 5 + data 8
        expect(totals.flash).toBe(23);
        expect(totals.ram).toBe(8 + 4);
        expect(totals.kindTotals.code).toBe(10);
        expect(totals.kindTotals.meta).toBe(3);
        expect(totals.keptCount).toBe(5);
    });

    it('excludes discarded rows from all totals', () => {
        const doc = {
            format: 'gnu-ld',
            file: 't',
            regions: [],
            symbols: [
                sym({ name: 'f', kind: 'code', size: 10 }),
                sym({ name: 'g', kind: 'code', size: 99, status: 'discarded' }),
            ],
            totals: { flash: 0, ram: 0, keptCount: 0, discardedCount: 0, fillTotal: 0, kindTotals: { code: 0, rodata: 0, data: 0, bss: 0, meta: 0, pad: 0, other: 0 }, regions: [] },
            warnings: [],
        } as MapDocument;
        const totals = computeStorageAndTotals(doc);
        expect(totals.flash).toBe(10);
        expect(totals.discardedCount).toBe(1);
        expect(totals.keptCount).toBe(1);
    });

    it('attributes symbols with lma into both regions', () => {
        const regions = [region('FLASH', 0x08000000, 0x10000), region('RAM', 0x20000000, 0x5000)];
        const doc = {
            format: 'gnu-ld',
            file: 't',
            regions,
            symbols: [
                sym({ name: 'f', kind: 'code', addr: 0x08000100, size: 10 }),
                sym({ name: 'd', kind: 'data', addr: 0x20000000, lma: 0x08000100, size: 8 }),
                sym({ name: 'b', kind: 'bss', addr: 0x20000008, size: 4 }),
            ],
            totals: { flash: 0, ram: 0, keptCount: 0, discardedCount: 0, fillTotal: 0, kindTotals: { code: 0, rodata: 0, data: 0, bss: 0, meta: 0, pad: 0, other: 0 }, regions: [] },
            warnings: [],
        } as unknown as MapDocument;
        assignRegionRoles(regions, doc.symbols);
        const totals = computeStorageAndTotals(doc);
        expect(totals.flash).toBe(18);
        expect(totals.ram).toBe(12);
        expect(totals.regions.find((r) => r.region.name === 'FLASH')!.used).toBe(18);
        expect(totals.regions.find((r) => r.region.name === 'RAM')!.used).toBe(12);
    });
});
