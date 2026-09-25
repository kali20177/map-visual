import { describe, expect, it } from 'vitest';
import { allocateSizes } from '../../src/parser/gnuld';
import { classifySection } from '../../src/parser/classify';
import { Warnings } from '../../src/parser/warnings';
import { discarded, findSym, kept, parseFixture } from './helpers';

describe('section classification', () => {
    it('classifies the corpus inventory', () => {
        expect(classifySection('.text')).toBe('code');
        expect(classifySection('.text._Z3addii')).toBe('code');
        expect(classifySection('.text.startup')).toBe('code');
        expect(classifySection('.iplt')).toBe('code');
        expect(classifySection('.glue_7')).toBe('code');
        expect(classifySection('.rodata.str1.1')).toBe('rodata');
        expect(classifySection('.ARM.exidx')).toBe('rodata');
        expect(classifySection('.ARM.extab')).toBe('rodata');
        expect(classifySection('.data.rel.ro')).toBe('data');
        expect(classifySection('.igot.plt')).toBe('data');
        expect(classifySection('.tdata')).toBe('data');
        expect(classifySection('.tbss')).toBe('bss');
        expect(classifySection('.lbss')).toBe('bss');
        expect(classifySection('COMMON')).toBe('bss');
        expect(classifySection('.noinit')).toBe('bss');
        expect(classifySection('.debug_info')).toBe('meta');
        expect(classifySection('.comment')).toBe('meta');
        expect(classifySection('.ARM.attributes')).toBe('meta');
        expect(classifySection('.init_array')).toBe('other');
    });
});

describe('GNU ld — x86 corpus (ported from imgui-gl3-glfw3-base)', () => {
    it('parses basic/test_simple.map with fills and crt objects', async () => {
        const doc = await parseFixture('gnuld-x86/basic/test_simple.map');
        const add = findSym(doc, 'add(int, int)');
        expect(add).toBeDefined();
        expect(add!.kind).toBe('code');
        expect(add!.size).toBeGreaterThan(0);
        expect(add!.storage).toContain('flash');

        const fills = kept(doc).filter((s) => s.isFill);
        expect(fills.length).toBeGreaterThan(0);
        expect(doc.totals.fillTotal).toBe(fills.reduce((a, f) => a + f.size, 0));
        expect(doc.totals.keptCount).toBeGreaterThan(10);
    });

    it('handles two-line entries in sections mode and sizes from address deltas', async () => {
        const doc = await parseFixture('gnuld-x86/sections/test_simple_sections.map');
        const add = findSym(doc, 'add(int, int)');
        expect(add).toBeDefined();
        // .text._Z3addii contribution is 0x18 with a single symbol
        expect(add!.size).toBe(0x18);
        expect(add!.section).toBe('.text._Z3addii');
        const main = findSym(doc, 'main');
        expect(main!.section).toBe('.text.main');
        expect(main!.size).toBe(0x1d);
    });

    it('extracts mangled static locals from section names (complex_sections)', async () => {
        const doc = await parseFixture('gnuld-x86/sections/test_complex_sections.map');
        const primes = findSym(doc, '.rodata._ZL13prime_numbers');
        expect(primes).toBeDefined();
        expect(primes!.mangled).toBe('_ZL13prime_numbers');
    });

    it('parses LTO maps with .ltrans objects and inlined-away symbols', async () => {
        const doc = await parseFixture('gnuld-x86/lto/test_simple_lto.map');
        const ltoRows = kept(doc).filter((s) => s.isLto);
        expect(ltoRows.length).toBeGreaterThan(0);
        expect(findSym(doc, 'main')).toBeDefined();
        // add() was inlined by LTO — it must not appear
        expect(findSym(doc, 'add(int, int)')).toBeUndefined();
    });

    it('assigns TLS kinds and splits multi-symbol contributions (tls/test_tls.map)', async () => {
        const doc = await parseFixture('gnuld-x86/tls/test_tls.map');
        const init = findSym(doc, 'tls_initialized');
        const uninit = findSym(doc, 'tls_uninitialized');
        expect(init!.kind).toBe('data');
        expect(uninit!.kind).toBe('bss');
        // .tdata contribution is 0x58 split across 3 symbols
        const group = kept(doc).filter((s) => s.section === '.tdata' && !s.isFill);
        expect(group.length).toBe(3);
        expect(group.reduce((a, s) => a + s.size, 0)).toBe(0x58);
    });

    it('keeps gc-sections output as a discarded bucket (discarded/test_discarded.map)', async () => {
        const doc = await parseFixture('gnuld-x86/discarded/test_discarded.map');
        expect(doc.totals.discardedCount).toBeGreaterThan(0);
        expect(discarded(doc).length).toBe(doc.totals.discardedCount);
        expect(findSym(doc, 'main')).toBeDefined();
        // discarded rows must not leak into totals
        expect(doc.totals.keptCount).toBe(kept(doc).length);
    });

    it('handles large-model sections (large/test_large_large.map)', async () => {
        const doc = await parseFixture('gnuld-x86/large/test_large_large.map');
        const huge = kept(doc).find((s) => s.kind === 'bss' && s.size === 0x40000);
        expect(huge).toBeDefined();
    });

    it('parses all 13 x86 fixtures without errors', async () => {
        const fixtures = [
            'gnuld-x86/basic/test_simple.map',
            'gnuld-x86/basic/test_complex.map',
            'gnuld-x86/sections/test_simple_sections.map',
            'gnuld-x86/sections/test_complex_sections.map',
            'gnuld-x86/lto/test_simple_lto.map',
            'gnuld-x86/lto/test_complex_lto.map',
            'gnuld-x86/sections_lto/test_simple_sections_lto.map',
            'gnuld-x86/sections_lto/test_complex_sections_lto.map',
            'gnuld-x86/tls/test_tls.map',
            'gnuld-x86/large/test_large.map',
            'gnuld-x86/large/test_large_large.map',
            'gnuld-x86/ifunc/test_ifunc.map',
            'gnuld-x86/discarded/test_discarded.map',
        ];
        for (const f of fixtures) {
            const doc = await parseFixture(f);
            expect(doc.format, f).toBe('gnu-ld');
            expect(doc.totals.keptCount, f).toBeGreaterThan(5);
            expect(doc.totals.flash, f).toBeGreaterThan(0);
            expect(doc.totals.ram, f).toBeGreaterThan(0);
        }
    });
});

describe('GNU ld — arm-none-eabi corpus (real embedded builds)', () => {
    it('splits archive members and computes sizes (firmware_sections_gc.map)', async () => {
        const doc = await parseFixture('gnuld-arm/firmware_sections_gc.map');
        const add3 = findSym(doc, 'util::add3(int, int, int)');
        expect(add3).toBeDefined();
        expect(add3!.archive).toContain('libutil.a');
        expect(add3!.member).toBe('lib.o');
        expect(add3!.size).toBe(8);
        expect(add3!.kind).toBe('code');
        expect(add3!.storage).toContain('flash');

        // same-object granularity: helper stays even though only add3 was referenced
        const helper = findSym(doc, 'util::helper(int)');
        expect(helper).toBeDefined();
        expect(helper!.size).toBe(8);
    });

    it('flags ARM sections, system objects and LTO-free rows', async () => {
        const doc = await parseFixture('gnuld-arm/firmware_sections_gc.map');
        const exidx = kept(doc).filter((s) => s.section.startsWith('.ARM.exidx') && s.size > 0);
        expect(exidx.length).toBeGreaterThan(0);
        expect(exidx.every((s) => s.kind === 'rodata')).toBe(true);

        const gccRow = kept(doc).find((s) => s.archive?.endsWith('libgcc.a'));
        expect(gccRow).toBeDefined();
        expect(gccRow!.isSystem).toBe(true);
    });

    it('maps FLASH/RAM regions by anchor and matches --print-memory-usage totals', async () => {
        const doc = await parseFixture('gnuld-arm/firmware_sections_gc.map');
        const flash = doc.regions.find((r) => r.name === 'FLASH');
        const ram = doc.regions.find((r) => r.name === 'RAM');
        expect(flash?.role).toBe('flash');
        expect(ram?.role).toBe('ram');

        // linker reported: FLASH 4152 B, RAM 260 B
        expect(doc.totals.ram).toBe(260);
        expect(doc.totals.flash).toBe(4152);
        const flashUsage = doc.totals.regions.find((r) => r.region.name === 'FLASH');
        const ramUsage = doc.totals.regions.find((r) => r.region.name === 'RAM');
        expect(flashUsage?.used).toBe(4152);
        expect(ramUsage?.used).toBe(260);
    });

    it('gc-removed sections appear in the discarded bucket, not in kept totals', async () => {
        const doc = await parseFixture('gnuld-arm/firmware_sections_gc.map');
        // clamp_value<int> was fully inlined — its out-of-line copy is gc'd
        const gcRow = discarded(doc).find((s) => s.name === '.text._ZN3app11clamp_valueIiEET_S1_S1_S1_');
        expect(gcRow).toBeDefined();
        expect(gcRow!.size).toBe(0x14);
        expect(kept(doc).find((s) => s.mangled?.includes('clamp_value'))).toBeUndefined();
        // unused global config_version: its 4-byte .data section is discarded
        expect(discarded(doc).find((s) => s.kind === 'data' && s.size === 0x4 && s.member === null)).toBeDefined();
    });

    it('handles --no-demangle maps (mangled symbol lines)', async () => {
        const doc = await parseFixture('gnuld-arm/firmware_no_demangle.map', { demangle: true });
        const used = findSym(doc, '_ZN4util4add3Eiii');
        expect(used).toBeDefined();
        expect(used!.demangled).toBe('util::add3(int, int, int)');
        const demangled = findSym(doc, 'util::add3(int, int, int)');
        expect(demangled).toBeDefined();
    });

    it('handles the no-function-sections baseline with multi-symbol .text', async () => {
        const doc = await parseFixture('gnuld-arm/firmware_basic.map');
        const main = findSym(doc, 'main');
        expect(main).toBeDefined();
        expect(main!.section).toBe('.text.startup');
        expect(main!.size).toBe(0x20);
        // stubs.o .text contribution: memcpy + memset split 0x24
        const memcpy = findSym(doc, 'memcpy');
        expect(memcpy!.size).toBe(0x14);
        expect(memcpy!.storage).toContain('flash');
    });
});

describe('size allocation algorithm (property-ish)', () => {
    const mk = (vma: number, size: number, addrs: number[]) => ({
        section: '.text',
        vma,
        size,
        lma: null,
        object: 'a.o',
        symbols: addrs.map((addr, i) => ({ addr, name: `sym${i}` })),
    });

    it('single symbol takes the whole contribution', () => {
        const w = new Warnings();
        expect(allocateSizes(mk(0x100, 0x40, [0x100]), w)).toEqual([0x40]);
    });

    it('splits by address deltas with tail to the last symbol', () => {
        const w = new Warnings();
        expect(allocateSizes(mk(0x100, 0x40, [0x100, 0x110, 0x130]), w)).toEqual([0x10, 0x20, 0x10]);
    });

    it('handles unsorted symbol lines', () => {
        const w = new Warnings();
        const sizes = allocateSizes(mk(0x100, 0x40, [0x130, 0x100, 0x110]), w);
        // input order: sym0@0x130 (tail 0x10), sym1@0x100 (0x10), sym2@0x110 (0x20)
        expect(sizes).toEqual([0x10, 0x10, 0x20]);
        expect(sizes.reduce((a, b) => a + b, 0)).toBe(0x40);
    });

    it('clamps symbols outside the contribution and warns', () => {
        const w = new Warnings();
        const sizes = allocateSizes(mk(0x100, 0x40, [0x100, 0x1000]), w);
        expect(sizes[0]).toBe(0x40);
        expect(sizes[1]).toBe(0);
        expect(w.list().length).toBeGreaterThan(0);
    });

    it('preserves the invariant on randomized inputs', () => {
        const w = new Warnings();
        for (let trial = 0; trial < 200; trial++) {
            const n = 1 + Math.floor(Math.random() * 8);
            const size = 16 * n;
            const addrs = Array.from({ length: n }, (_, i) => 0x100 + i * 16);
            // shuffle
            for (let i = n - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [addrs[i], addrs[j]] = [addrs[j], addrs[i]];
            }
            const sizes = allocateSizes(mk(0x100, size, addrs), w);
            expect(sizes.reduce((a, b) => a + b, 0)).toBe(size);
            expect(sizes.every((s) => s >= 0)).toBe(true);
        }
    });
});
