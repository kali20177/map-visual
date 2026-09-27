import { describe, expect, it } from 'vitest';
import { parseLld } from '../../src/parser/lld';
import { Warnings } from '../../src/parser/warnings';
import { parseMapText } from '../../src/parser/pipeline';
import { findSym, readFixture } from './helpers';

const LLD_MAP = `    VMA      LMA     Size Align Out     In      Symbol
000101c0 000101c0      21c     4 .text
000101c0 000101c0        4     4         crt0.o:(.text.startup)
000101c0 000101c0        4     4                 _start
000101c4 000101c4       1c     4         main.cpp.o:(.text.main)
000101c4 000101c4       1c     4                 main
00010300 00010300       10     4 .rodata
00010300 00010300       10     1         main.cpp.o:(.rodata.table)
00010300 00010300       10     1                 table
00010400 00010400        8     4 .data
00010400 00010400        4     4         main.cpp.o:(.data.config_version)
00010400 00010400        4     4                 config_version
00010408 00010408        c     4 .bss
00010408 00010408        c     4         main.cpp.o:(.bss.buffer)
00010408 00010408        c     4                 buffer
00010500 00010500        4     4         <internal>:(.got)
`;

describe('lld tabular parser', () => {
    it('parses output/input/symbol rows', () => {
        const w = new Warnings();
        const { symbols } = parseLld(LLD_MAP, w);
        const main = symbols.find((s) => s.name === 'main');
        expect(main).toBeDefined();
        expect(main!.size).toBe(0x1c);
        expect(main!.section).toBe('.text.main');
        expect(main!.object).toBe('main.cpp.o');
        expect(main!.kind).toBe('code');
        expect(main!.addr).toBe(0x000101c4);
        expect(main!.lma).toBe(0x000101c4);
    });

    it('classifies kinds and handles <internal> input rows', () => {
        const w = new Warnings();
        const { symbols } = parseLld(LLD_MAP, w);
        const buffer = symbols.find((s) => s.name === 'buffer');
        expect(buffer!.kind).toBe('bss');
        const table = symbols.find((s) => s.name === 'table');
        expect(table!.kind).toBe('rodata');
        const got = symbols.find((s) => s.section === '.got');
        expect(got).toBeDefined();
        expect(got!.object).toBe('<internal>');
        expect(w.list().length).toBe(0);
    });

    it('produces correct flash/ram totals via the pipeline', async () => {
        const doc = await parseMapText(LLD_MAP, 'lld.map', { demangle: false, formatOverride: 'auto' });
        expect(doc.format).toBe('lld');
        // flash: _start 4 + main 28 + table 16 + config_version 4 + .got section row 4
        expect(doc.totals.flash).toBe(56);
        // ram: config_version 4 + buffer 12 + .got section row 4
        expect(doc.totals.ram).toBe(20);
        const config = findSym(doc, 'config_version');
        expect(config!.storage).toEqual(['flash', 'ram']);
        expect(findSym(doc, 'buffer')!.storage).toEqual(['ram']);
    });

    it('flags mangled symbol rows for demangling', async () => {
        const mangled = LLD_MAP.replace('                main\n', '                _ZN3app4mainEv\n');
        const doc = await parseMapText(mangled, 'lld2.map', { demangle: false, formatOverride: 'lld' });
        const row = doc.symbols.find((s) => s.name === '_ZN3app4mainEv');
        expect(row).toBeDefined();
        expect(row!.mangled).toBe('_ZN3app4mainEv');
    });

    describe('real ld.lld fixture (armv7m, Homebrew LLD 23.1.2)', () => {
        it('parses the real map with exact totals', async () => {
            const doc = await parseMapText(readFixture('lld/firmware_lld.map'), 'firmware_lld.map', { demangle: false, formatOverride: 'auto' });
            expect(doc.format).toBe('lld');

            // input section without symbol rows keeps its real size (was a bug: hardcoded 0)
            const exidx = doc.symbols.find((s) => s.section === '.ARM.exidx');
            expect(exidx!.size).toBe(0x18);
            expect(exidx!.object).toBe('<internal>');

            const main = findSym(doc, 'main');
            expect(main!.size).toBe(0x12); // map sizes are hex without prefix
            expect(main!.section).toBe('.text');

            const counter = findSym(doc, 'shared_counter');
            expect(counter!.kind).toBe('data');
            expect(counter!.storage).toEqual(['flash', 'ram']);

            // non-alloc ELF metadata is meta → no storage, excluded from totals
            const symtab = findSym(doc, '.symtab');
            expect(symtab!.kind).toBe('meta');
            expect(symtab!.storage).toEqual([]);

            // flash = exidx 0x18 + $t 0 + compute 4 + main 0x12 + data 4
            expect(doc.totals.flash).toBe(50);
            expect(doc.totals.ram).toBe(4);
        });

        it('keeps ARM mapping symbols ($t) as zero-size code rows', async () => {
            const doc = await parseMapText(readFixture('lld/firmware_lld.map'), 'firmware_lld.map', { demangle: false, formatOverride: 'auto' });
            const t = doc.symbols.find((s) => s.name === '$t');
            expect(t).toBeDefined();
            expect(t!.size).toBe(0);
            expect(t!.kind).toBe('code');
        });
    });
});

describe('lld raw map line capture', () => {
    it('records 1-based raw lines for symbol and section rows', () => {
        const w = new Warnings();
        const { symbols } = parseLld(LLD_MAP, w);
        // the header line is line 1 of the map text
        expect(symbols.find((s) => s.name === 'main')!.line).toBe(6);
        expect(symbols.find((s) => s.name === '_start')!.line).toBe(4);
        const got = symbols.find((s) => s.name === '.got');
        expect(got!.fromSectionName).toBe(true);
        expect(got!.line).toBe(16);
    });
});
