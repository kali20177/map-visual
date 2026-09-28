import { describe, expect, it } from 'vitest';
import { allocateSizes, parseGnuLd } from '../../src/parser/gnuld';
import { classifySection } from '../../src/parser/classify';
import { Warnings } from '../../src/parser/warnings';
import { parseMapText } from '../../src/parser/pipeline';
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
        // Zephyr's dot-less script section names (exact table)
        expect(classifySection('text')).toBe('code');
        expect(classifySection('rodata')).toBe('rodata');
        expect(classifySection('ramfunc')).toBe('code');
        expect(classifySection('datas')).toBe('data');
        expect(classifySection('device_states')).toBe('data');
        expect(classifySection('bss')).toBe('bss');
        expect(classifySection('noinit')).toBe('bss');
        expect(classifySection('._user_heap_stack')).toBe('bss');
        // exact match must not leak into prefix hits
        expect(classifySection('database')).toBe('other');
        expect(classifySection('textfile')).toBe('other');
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

describe('GNU ld — COMMON contributions and diagnostics', () => {
    it('parses -fcommon COMMON blocks as bss with exact RAM (firmware_common.map)', async () => {
        const doc = await parseFixture('gnuld-arm/firmware_common.map');
        const bc = findSym(doc, 'b_common');
        const ac = findSym(doc, 'a_common');
        expect(bc).toBeDefined();
        expect(bc!.section).toBe('COMMON');
        expect(bc!.kind).toBe('bss');
        expect(bc!.size).toBe(16);
        expect(bc!.storage).toEqual(['ram']);
        expect(ac!.size).toBe(4);
        // ld --print-memory-usage golden: FLASH 44 B / RAM 24 B (.data 4 + COMMON 20)
        expect(doc.totals.flash).toBe(44);
        expect(doc.totals.ram).toBe(24);
        expect(doc.warnings).toEqual([]);
    });

    it('skips wildcard object echoes without warning (x86 corpus)', async () => {
        const doc = await parseFixture('gnuld-x86/basic/test_simple.map');
        expect(doc.warnings).toEqual([]);
    });

    it('recovers mangled forms for symbol lines inside mangled sections', async () => {
        const doc = await parseFixture('gnuld-x86/sections/test_simple_sections.map');
        const add = findSym(doc, 'add(int, int)');
        expect(add).toBeDefined();
        expect(add!.mangled).toBe('_Z3addii');
        const cpp = await parseFixture('gnuld-arm/firmware_cpp_sections.map');
        const next = findSym(cpp, 'app::Sensor::next(int)');
        expect(next).toBeDefined();
        expect(next!.section).toBe('.text._ZN3app6Sensor4nextEi');
        expect(next!.mangled).toBe('_ZN3app6Sensor4nextEi');
        const clamp = findSym(cpp, 'int app::clamp_value<int>(int, int, int)');
        expect(clamp!.mangled).toBe('_ZN3app11clamp_valueIiEET_S1_S1_S1_');
        // ld --print-memory-usage golden: FLASH 120 B / RAM 4 B
        expect(cpp.totals.flash).toBe(120);
        expect(cpp.totals.ram).toBe(4);
    });

    it('attaches line numbers to line-level warnings', () => {
        const w = new Warnings();
        parseGnuLd('Linker script and memory map\n\n.text 0x1000 0x10 a.o\n\n ???not a parseable line\n', w);
        const list = w.list();
        expect(list[0].message).toBe('unrecognized line');
        expect(list[0].line).toBe(5);
    });

    it('parses the dot-less shellCommand fixture against --print-memory-usage', async () => {
        const doc = await parseFixture('gnuld-arm/firmware_shellcmd.map');
        const cmds = findSym(doc, 'shell_commands');
        expect(cmds).toBeDefined();
        expect(cmds!.section).toBe('shellCommand');
        expect(cmds!.kind).toBe('other');
        expect(cmds!.size).toBe(16);
        expect(cmds!.storage).toEqual(['flash']);
        // P1（REVIEW-26a5b23）: main 在贡献偏移 6，size 是到贡献末尾的 4B，
        // 前缀 6B 输出为 *unsym* 行（总量 44 不变）
        const main = findSym(doc, 'main');
        expect(main!.size).toBe(4);
        expect(doc.symbols.find((x) => x.name === '*unsym*')!.size).toBe(6);
        // ld --print-memory-usage golden: FLASH 44 B / RAM 0 B
        expect(doc.totals.flash).toBe(44);
        expect(doc.totals.ram).toBe(0);
        expect(doc.warnings).toEqual([]);
    });
});

describe('GNU ld — real-world section forms (LTO / script-only sections)', () => {
    const SYNTH_HEAD = [
        'Memory Configuration',
        '',
        'Name             Origin             Length             Attributes',
        'FLASH            0x0000000008000000 0x0000000000020000 xr',
        'RAM              0x0000000020000000 0x0000000000010000 xrw',
        '',
        '',
        'Linker script and memory map',
        '',
    ].join('\n');

    it('drops stale pre-merge snapshot lines and keeps the tiling chain', () => {
        // Reproduces the LTO+string-merge shape: ld re-prints merged-out input
        // sections at their pre-merge extent; the output section is only 0x40.
        const w = new Warnings();
        const { symbols } = parseGnuLd(
            [
                'Linker script and memory map',
                '',
                '.rodata         0x08000010       0x40',
                ' *(.rodata*)',
                ' .rodata.str1.1',
                '                0x08000010       0x30 a.o',
                '                                 0x8 (size before relaxing)',
                ' .rodata.main.str1.1',
                '                0x08000040       0x20 a.o',
                ' .rodata.tab    0x08000040        0x8 a.o',
                '                0x08000040                tab',
                ' .rodata.other  0x08000048        0x8 a.o',
            ].join('\n'),
            w,
        );
        expect(w.list()).toEqual([]);
        expect(symbols.filter((s) => s.name === '.rodata.main.str1.1')).toEqual([]);
        const flash = symbols.filter((s) => s.kind !== 'meta').reduce((a, s) => a + s.size, 0);
        expect(flash).toBe(0x40);
        const tab = symbols.find((s) => s.name === 'tab');
        expect(tab!.size).toBe(8);
        expect(tab!.section).toBe('.rodata.tab');
    });

    it('tiles script-only sections with fills and keeps them out of flash', async () => {
        // `._user_heap_stack` prints as a two-line header (NOLOAD): its fills
        // occupy RAM only, never the flash load image.
        const text = [
            SYNTH_HEAD,
            '.data           0x20000000        0x8 load address 0x08000010',
            ' *(.data*)',
            ' .data          0x20000000        0x8 a.o',
            '                0x20000000                dv',
            '._user_heap_stack',
            '                0x20000008      0x408 load address 0x08000018',
            ' *fill*         0x20000008        0x8 ',
            '                0x20000010                        . = (. + _Min_Heap_Size)',
            ' *fill*         0x20000010      0x400 ',
        ].join('\n');
        const doc = await parseMapText(text, 'synthetic', { demangle: false, formatOverride: 'gnu-ld' }, undefined);
        expect(doc.warnings).toEqual([]);
        const dv = findSym(doc, 'dv')!;
        expect(dv.storage).toEqual(['flash', 'ram']);
        const fills = doc.symbols.filter((s) => s.isFill);
        expect(fills.map((f) => f.size)).toEqual([8, 0x400]);
        expect(fills.map((f) => f.storage)).toEqual([['ram'], ['ram']]);
        expect(doc.totals.flash).toBe(8);
        expect(doc.totals.ram).toBe(8 + 8 + 0x400);
    });

    it('parses dot-less custom section contributions (section("shellCommand"))', () => {
        const w = new Warnings();
        const { symbols } = parseGnuLd(
            [
                'Linker script and memory map',
                '',
                '.text           0x08000000       0x14 a.o',
                ' *(.text*)',
                ' .text          0x08000000       0x10 a.o',
                '                0x08000000                main',
                ' shellCommand   0x08000010        0x4 a.o',
                '                0x08000010                cmds',
            ].join('\n'),
            w,
        );
        expect(w.list()).toEqual([]);
        const cmds = symbols.find((s) => s.name === 'cmds');
        expect(cmds).toBeDefined();
        expect(cmds!.section).toBe('shellCommand');
        expect(cmds!.kind).toBe('other');
        expect(cmds!.size).toBe(4);
    });

    it('attributes script data rows (LONG) to the surrounding output section', () => {
        const w = new Warnings();
        const { symbols } = parseGnuLd(
            [
                'Linker script and memory map',
                '',
                '.fw_signature  0x08000000       0x8',
                '                0x08000000        0x4 LONG 0x47535746',
                '                0x08000004        0x4 LONG 0x1',
                '/DISCARD/',
                ' libc.a(*)',
                ' libm.a(*)',
                'FILL mask 0xff',
            ].join('\n'),
            w,
        );
        expect(w.list()).toEqual([]);
        const rows = symbols.filter((s) => s.section === '.fw_signature');
        expect(rows.map((r) => r.size)).toEqual([4, 4]);
        expect(rows.every((r) => r.kind === 'other')).toBe(true);
    });

    it('keeps zero-init (.bss) fills out of the flash image even with a load address', async () => {
        const text = [
            SYNTH_HEAD,
            '.bss            0x20000000      0x408 load address 0x08000100',
            ' *fill*         0x20000000      0x408 ',
        ].join('\n');
        const doc = await parseMapText(text, 'synthetic', { demangle: false, formatOverride: 'gnu-ld' }, undefined);
        expect(doc.warnings).toEqual([]);
        const fill = doc.symbols.find((s) => s.isFill)!;
        expect(fill.storage).toEqual(['ram']);
        expect(doc.totals.flash).toBe(0);
        expect(doc.totals.ram).toBe(0x408);
    });

    it('parses a wrapped dot-less section name and keeps the contribution off the outer section', () => {
        // A dot-less custom section name longer than the column width wraps:
        // name alone on its own line, address + object on the next.
        const w = new Warnings();
        const { symbols } = parseGnuLd(
            [
                'Linker script and memory map',
                '',
                '.text           0x08000000       0x20',
                ' .text          0x08000000       0x10 a.o',
                '                0x08000000                main',
                ' shellCommand_table_for_everything_long',
                '                0x08000010        0x10 a.o',
                '                0x08000010                cmds',
            ].join('\n'),
            w,
        );
        expect(w.list()).toEqual([]);
        const cmds = symbols.find((s) => s.name === 'cmds');
        expect(cmds).toBeDefined();
        expect(cmds!.section).toBe('shellCommand_table_for_everything_long');
        expect(cmds!.kind).toBe('other');
        expect(cmds!.size).toBe(0x10);
    });

    it('takes a bare extent line as a two-line header extent and tiles against it', () => {
        // Corpus form of `._user_heap_stack`: col0 bare name + plain
        // `<vma> <size>` (no `load address`). Tiling must engage and drop a
        // stale overlapping row.
        const w = new Warnings();
        const { symbols } = parseGnuLd(
            [
                'Linker script and memory map',
                '',
                '._user_heap_stack',
                '                0x20002aec      0x604',
                ' .stale         0x20002aec        0x8 a.o',
                ' *fill*         0x20002aec        0x4',
                ' .heap          0x20002af0      0x600 a.o',
            ].join('\n'),
            w,
        );
        expect(w.list()).toEqual([]);
        expect(symbols.map((s) => s.name)).not.toContain('.stale');
        expect(symbols.reduce((a, s) => a + s.size, 0)).toBe(0x604);
    });

    it('keeps bare-extent NOLOAD fills out of the flash image (corpus ._user_heap_stack form)', async () => {
        const text = [
            SYNTH_HEAD,
            '.data           0x20000000        0x8 load address 0x08000010',
            ' *(.data*)',
            ' .data          0x20000000        0x8 a.o',
            '                0x20000000                dv',
            '._user_heap_stack',
            '                0x20000008      0x408',
            ' *fill*         0x20000008      0x408 ',
        ].join('\n');
        const doc = await parseMapText(text, 'synthetic', { demangle: false, formatOverride: 'gnu-ld' }, undefined);
        expect(doc.warnings).toEqual([]);
        const fills = doc.symbols.filter((s) => s.isFill);
        expect(fills.map((f) => f.storage)).toEqual([['ram']]);
        expect(doc.totals.flash).toBe(8);
        expect(doc.totals.ram).toBe(8 + 0x408);
    });

    it('prefers symbol-bearing units among same-VMA candidates in both print orders', () => {
        // Stale pre-merge re-prints carry no symbol lines. When a snapshot
        // size coincides with the real contribution step, the tiling chain
        // must still keep the real rows — whether the snapshot was printed
        // before or after them.
        for (const snapFirst of [true, false]) {
            const w = new Warnings();
            const lines = ['Linker script and memory map', '', '.rodata         0x00001000       0x100'];
            for (const c of [0x1000, 0x1040, 0x1080, 0x10c0]) {
                const snap = ` .snap_${c.toString(16)}  0x${c.toString(16)}  0x40 a.o`;
                const real = [
                    ` .real          0x${c.toString(16)}  0x40 a.o`,
                    `                0x${c.toString(16)}                realsym${c.toString(16)}`,
                ];
                lines.push(...(snapFirst ? [snap, ...real] : [...real, snap]));
            }
            const { symbols } = parseGnuLd(lines.join('\n'), w);
            expect(w.list()).toEqual([]);
            expect(symbols.filter((s) => s.name.startsWith('realsym'))).toHaveLength(4);
            expect(symbols.filter((s) => s.name.startsWith('.snap'))).toEqual([]);
            expect(symbols.reduce((a, s) => a + s.size, 0)).toBe(0x100);
        }
    });

    it('falls back to keep-all with an observable warning when the tiling budget blows', () => {
        const w = new Warnings();
        const lines = ['Linker script and memory map', '', '.rodata         0x00001000       0x200'];
        for (let i = 0; i < 160; i++) {
            lines.push(` .top${i}         0x00001000       0x100 a.o`);
        }
        for (let i = 0; i < 160; i++) {
            lines.push(` .mid${i}         0x00001100        0x80 a.o`);
        }
        const { symbols } = parseGnuLd(lines.join('\n'), w);
        // no chain tiles 0x200 with 0x100 + 0x80 — the search exhausts its
        // visit budget and falls back to keeping every unit, visibly.
        expect(symbols).toHaveLength(320);
        expect(w.list()).toHaveLength(1);
        expect(w.list()[0]!.message).toContain('budget');
    });
});

describe('GNU ld — Zephyr dot-less script sections', () => {
    const ZHEAD = [
        'Memory Configuration',
        '',
        'Name             Origin             Length             Attributes',
        'FLASH            0x08000000 0x00020000 xr',
        'RAM              0x20000000 0x00005000 xw',
        'DEVNULL_ROM      0x08020000 0x00040000 xr',
        '',
        'Linker script and memory map',
        '',
    ].join('\n');

    it('parses dot-less one-line output section headers', () => {
        // Zephyr prints `text 0x080000e8 0xfa7c`, `bss 0x20000338 0x1982`, ...
        const w = new Warnings();
        const { symbols } = parseGnuLd(
            [
                ZHEAD,
                'text            0x08000000      0x14',
                ' .text          0x08000000      0x10 a.o',
                '                0x08000000                main',
                ' *fill*         0x08000010        0x4 ',
                'bss             0x20000000       0x8',
                ' .bss.x         0x20000000       0x8 a.o',
                '                0x20000000                x',
            ].join('\n'),
            w,
        );
        expect(w.list()).toEqual([]);
        const main = symbols.find((s) => s.name === 'main');
        expect(main!.kind).toBe('code');
        const x = symbols.find((s) => s.name === 'x');
        expect(x!.kind).toBe('bss');
        const fill = symbols.find((s) => s.isFill)!;
        expect(fill.size).toBe(4);
    });

    it('honors load addresses of initialized two-line dot-less headers, not NOLOAD ones', async () => {
        // Zephyr `log_msg_ptr_area`: two-line dot-less header whose echoed
        // load address IS the flash image location; `._user_heap_stack`:
        // same form, but the echoed load address is script residue.
        const text = [
            ZHEAD,
            'datas            0x20000000        0x8 load address 0x08001000',
            ' .data.x         0x20000000        0x8 a.o',
            '                 0x20000000                dv',
            'log_msg_ptr_area',
            '                 0x20000008        0x4 load address 0x08001008',
            ' ._log_msg_ptr.static.ptr_',
            '                 0x20000008        0x4 a.o',
            '                 0x20000008                p',
            '._user_heap_stack',
            '                 0x2000000c       0x10 load address 0x0800100c',
            ' *fill*          0x2000000c       0x10 ',
        ].join('\n');
        const doc = await parseMapText(text, 'synthetic', { demangle: false, formatOverride: 'gnu-ld' }, undefined);
        expect(doc.warnings).toEqual([]);
        const dv = doc.symbols.find((s) => s.name === 'dv')!;
        expect(dv.storage).toEqual(['flash', 'ram']);
        const p = doc.symbols.find((s) => s.name === 'p')!;
        // other-kind contribution with a load image counts in flash too
        expect(p.storage).toEqual(['flash', 'ram']);
        const fill = doc.symbols.find((s) => s.isFill)!;
        expect(fill.storage).toEqual(['ram']);
        expect(doc.totals.flash).toBe(12);
        expect(doc.totals.ram).toBe(28);
    });

    it('skips linker-script ASSERT lines that echo an address', () => {
        // Zephyr: `0x00000001 ASSERT ((SIZEOF (initlevel_error) == 0x0), ...)`
        const w = new Warnings();
        const { symbols } = parseGnuLd(
            [
                'Linker script and memory map',
                '',
                'initlevel_error',
                ' *(SORT_BY_NAME(SORT_BY_ALIGNMENT(.z_init_*)))',
                '                0x00000001                        ASSERT ((SIZEOF (initlevel_error) == 0x0), Undefined initialization levels used.)',
                'text            0x08000000      0x10',
                ' .text          0x08000000      0x10 a.o',
                '                0x08000000                main',
            ].join('\n'),
            w,
        );
        expect(w.list()).toEqual([]);
        expect(symbols.filter((s) => s.name.startsWith('ASSERT'))).toEqual([]);
        expect(symbols.find((s) => s.name === 'main')).toBeDefined();
    });

    it('keeps Zephyr struct sections (kind other, load image) in flash', async () => {
        // `._k_heap.static.*` lives in RAM but its load image is in FLASH.
        const text = [
            ZHEAD,
            'text             0x08000000       0x10',
            ' .text           0x08000000       0x10 a.o',
            '                 0x08000000                main',
            'bss              0x20000338        0x8',
            ' .bss.x          0x20000338        0x8 a.o',
            '                 0x20000338                x',
            'k_heap_area       0x200002fc       0x18 load address 0x08012d90',
            ' ._k_heap.static.heap_',
            '                 0x200002fc       0x18 a.o',
            '                 0x200002fc                h',
        ].join('\n');
        const doc = await parseMapText(text, 'synthetic', { demangle: false, formatOverride: 'gnu-ld' }, undefined);
        expect(doc.warnings).toEqual([]);
        const h = doc.symbols.find((s) => s.name === 'h')!;
        expect(h.kind).toBe('other');
        expect(h.storage).toEqual(['flash', 'ram']);
        expect(doc.totals.flash).toBe(0x10 + 0x18);
        expect(doc.totals.ram).toBe(0x8 + 0x18);
    });
});

describe('size allocation algorithm (property-ish)', () => {
    const mk = (vma: number, size: number, addrs: number[]) => ({
        section: '.text',
        vma,
        size,
        lma: null,
        object: 'a.o',
        sectionLine: 1,
        symbols: addrs.map((addr, i) => ({ addr, name: `sym${i}`, line: 2 })),
    });

    it('single symbol takes the whole contribution', () => {
        const w = new Warnings();
        expect(allocateSizes(mk(0x100, 0x40, [0x100]), w).sizes).toEqual([0x40]);
    });

    it('splits by address deltas with tail to the last symbol', () => {
        const w = new Warnings();
        expect(allocateSizes(mk(0x100, 0x40, [0x100, 0x110, 0x130]), w).sizes).toEqual([0x10, 0x20, 0x10]);
    });

    it('handles unsorted symbol lines', () => {
        const w = new Warnings();
        const { sizes } = allocateSizes(mk(0x100, 0x40, [0x130, 0x100, 0x110]), w);
        // input order: sym0@0x130 (tail 0x10), sym1@0x100 (0x10), sym2@0x110 (0x20)
        expect(sizes).toEqual([0x10, 0x10, 0x20]);
        expect(sizes.reduce((a, b) => a + b, 0)).toBe(0x40);
    });

    it('clamps symbols outside the contribution and warns', () => {
        const w = new Warnings();
        const { sizes } = allocateSizes(mk(0x100, 0x40, [0x100, 0x1000]), w);
        expect(sizes[0]).toBe(0x40);
        expect(sizes[1]).toBe(0);
        expect(w.list().length).toBeGreaterThan(0);
    });

    it('clamps a single symbol starting mid-contribution and returns the prefix', () => {
        const w = new Warnings();
        const a = allocateSizes(mk(0x100, 0x40, [0x110]), w);
        expect(a.sizes).toEqual([0x30]);
        expect(a.prefixPad).toBe(0x10);
        expect(w.list()).toEqual([]);
    });

    it('models the prefix gap before the first symbol in multi-symbol groups', () => {
        const w = new Warnings();
        const a = allocateSizes(mk(0x100, 0x40, [0x110, 0x120]), w);
        expect(a.sizes).toEqual([0x10, 0x20]);
        expect(a.prefixPad).toBe(0x10);
        expect(w.list()).toEqual([]);
    });

    it('warns on a single symbol sitting before the contribution', () => {
        const w = new Warnings();
        const a = allocateSizes(mk(0x100, 0x40, [0x80]), w);
        expect(a.sizes).toEqual([0x40]);
        expect(a.prefixPad).toBe(0);
        expect(w.list()).toHaveLength(1);
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
            const { sizes } = allocateSizes(mk(0x100, size, addrs), w);
            expect(sizes.reduce((a, b) => a + b, 0)).toBe(size);
            expect(sizes.every((s) => s >= 0)).toBe(true);
        }
    });
});


describe('GNU ld — geometry regressions (review P1/P2, REVIEW-26a5b23)', () => {
    it('models the unsymboled prefix of a single-symbol contribution (*unsym*)', () => {
        // 贡献 [0x08000000,0x10)，符号在偏移 4：旧实现把整个 0x10 给符号，
        // 区间越过贡献末尾且零告警（Σ 校验在单符号分支恒真）。
        const w = new Warnings();
        const { symbols } = parseGnuLd(
            ['Linker script and memory map', '', ' .text           0x08000000       0x10 a.o', '                0x08000004                partial_func'].join('\n'),
            w,
        );
        expect(w.list()).toEqual([]);
        const fn = symbols.find((x) => x.name === 'partial_func')!;
        expect(fn.size).toBe(0xc);
        const pad = symbols.find((x) => x.name === '*unsym*')!;
        expect(pad.addr).toBe(0x08000000);
        expect(pad.size).toBe(4);
        expect(pad.kind).toBe('code');
        expect(symbols.reduce((a, x) => a + x.size, 0)).toBe(0x10);
    });

    it('.data prefix bytes occupy the flash load image too', async () => {
        const text = [
            'Memory Configuration',
            '',
            'Name             Origin             Length             Attributes',
            'FLASH            0x08000000 0x00020000 xr',
            'RAM              0x20000000 0x00010000 xrw',
            '',
            'Linker script and memory map',
            '',
            '.data            0x20000000       0x10 load address 0x08000040',
            ' .data           0x20000000       0x10 a.o',
            '                0x20000008                dv',
        ].join('\n');
        const doc = await parseMapText(text, 'synthetic', { demangle: false, formatOverride: 'gnu-ld' }, undefined);
        expect(doc.warnings).toEqual([]);
        const pad = doc.symbols.find((x) => x.name === '*unsym*')!;
        expect(pad.kind).toBe('data');
        expect(pad.storage).toEqual(['flash', 'ram']);
        expect(doc.totals.flash).toBe(0x10);
        expect(doc.totals.ram).toBe(0x10);
    });

    it('keeps every unit of non-alloc (meta) sections without tiling — .ARM.attributes form', () => {
        // 非分配段的 VMA 列是文件内偏移累加，与段头 size 不构成地址空间，
        // tiling 前提不成立——keep-all 静默是正确行为而非退化。
        const w = new Warnings();
        const lines = ['Linker script and memory map', '', '.ARM.attributes  0x00000000       0x29'];
        for (let i = 0; i < 9; i++) {
            lines.push(` .ARM.attributes  0x00000000       0x1d a${i}.o`);
        }
        const { symbols } = parseGnuLd(lines.join('\n'), w);
        expect(symbols).toHaveLength(9);
        expect(w.list()).toEqual([]);
    });

    it('warns when the section extent is unknown instead of silently keep-all (review N2)', () => {
        const w = new Warnings();
        const { symbols } = parseGnuLd(
            [
                'Linker script and memory map',
                '',
                '.text',
                ' .text           0x08000000       0x10 a.o',
                '                0x08000000                main',
                ' .text           0x08000000       0x10 b.o',
                '                0x08000000                other',
            ].join('\n'),
            w,
        );
        // 裸名段头的 extent 行缺失：无从 tiling，只能 keep-all，但必须出声
        expect(symbols).toHaveLength(2);
        expect(w.list()).toHaveLength(1);
        expect(w.list()[0]!.message).toContain('extent unknown');
    });

    it('clamps the multi-symbol prefixPad so *unsym* cannot leave the contribution (review N3)', () => {
        const w = new Warnings();
        const { symbols } = parseGnuLd(
            [
                'Linker script and memory map',
                '',
                ' .text           0x08000000       0x10 a.o',
                '                0x08000020                sym_a',
                '                0x08000024                sym_b',
            ].join('\n'),
            w,
        );
        const pad = symbols.find((x) => x.name === '*unsym*')!;
        expect(pad.size).toBe(0x10);
        expect(pad.addr + pad.size).toBe(0x08000010);
        // 数据自相矛盾：sum 校验仍要出声
        expect(w.list()[0]!.message).toContain('do not sum');
    });

    it('warns when an alloc section cannot tile exactly even though the budget is intact', () => {
        const w = new Warnings();
        const { symbols } = parseGnuLd(
            [
                'Linker script and memory map',
                '',
                '.text            0x08000000       0x20',
                ' .text           0x08000000       0x10 a.o',
                '                0x08000000                func_a',
                ' .text           0x08000010       0x8  a.o',
                '                0x08000010                stale_copy',
                ' .text           0x08000014       0x8  b.o',
                '                0x08000014                func_b',
            ].join('\n'),
            w,
        );
        expect(w.list()).toHaveLength(1);
        expect(w.list()[0]!.message).toContain('tiling search failed');
        expect(w.list()[0]!.message).not.toContain('budget');
        // keep-all 兜底保留全部行
        expect(symbols.map((x) => x.name)).toContain('stale_copy');
    });
});

describe('raw map line capture (split-mode locate)', () => {
    it('pins symbol rows to their 1-based raw line', async () => {
        const doc = await parseFixture('gnuld-x86/basic/test_simple.map');
        expect(findSym(doc, 'main')!.line).toBe(192);
    });

    it('pins fill rows to their *fill* line', async () => {
        const doc = await parseFixture('gnuld-x86/basic/test_complex.map');
        const fills = doc.symbols.filter((s) => s.isFill);
        expect(fills.length).toBeGreaterThan(0);
        expect(fills.some((f) => f.line === 188)).toBe(true);
    });

    it('pins discarded rows to the line naming them', async () => {
        const doc = await parseFixture('gnuld-x86/discarded/test_discarded.map');
        const rows = doc.symbols.filter((s) => s.status === 'discarded');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.line != null)).toBe(true);
        expect(rows.find((r) => r.name === '.rodata.cst4')!.line).toBe(11);
    });

    // GNU ld 不给本地符号打符号行：-ffunction-sections 下每个 static/内部函数
    // （libgcc、LTO 内化后的函数）只剩「裸段头 + 贡献行」两行，段级行的定位
    // 目标因此必须是印着段名的那一行，而不是只印地址/尺寸/目标文件的贡献行
    it('pins section-level rows to the line printing the section name', async () => {
        const doc = await parseFixture('gnuld-arm/firmware_basic.map');
        const row = doc.symbols.find((s) => s.name === '.text.selfrel_offset31');
        expect(row!.fromSectionName).toBe(true);
        expect(row!.line).toBe(57);
        // 同一段里符号是全局时 ld 照打符号行——那条路径不受影响
        expect(findSym(doc, '__aeabi_unwind_cpp_pr1')!.line).toBe(118);
    });
});
