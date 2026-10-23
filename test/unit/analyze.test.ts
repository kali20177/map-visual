import { describe, expect, it } from 'vitest';
import { assignRegionRoles, computeStorageAndTotals } from '../../src/analysis/analyze';
import { parseMapText } from '../../src/parser/pipeline';
import { parseFixture } from './helpers';
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
        isReserve: false,
        fromSectionName: false,
        isSystem: false,
        isLto: false,
        outSection: null,
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

    it('trusts IDF segment names when IRAM code outweighs IROM (classic ESP32)', () => {
        // 真实 hello_world ESP32：IRAM 51.7 KB > IROM 47.4 KB —— 纯 code
        // 质量投票会把 iram0_0_seg 判成 flash、iram0_2_seg 判成 ram。
        const regions = [
            region('iram0_0_seg', 0x40080000, 0x20000),
            region('iram0_2_seg', 0x400d0020, 0x330000),
            region('dram0_0_seg', 0x3ffb0000, 0x2c200),
            region('drom0_0_seg', 0x3f400020, 0x3fffe0),
        ];
        assignRegionRoles(regions, [
            sym({ addr: 0x40080100, kind: 'code', size: 0x50 }),
            sym({ addr: 0x400d0100, kind: 'code', size: 0x40 }),
            sym({ addr: 0x3ffb0100, kind: 'bss', size: 0x10 }),
        ]);
        expect(regions.map((r) => r.role)).toEqual(['ram', 'flash', 'ram', 'flash']);
    });

    it('keeps drom0_0 flash when .ext_ram.bss shares its window (S3 SPIRAM)', () => {
        // extern_ram_seg 与 drom0_0_seg 同址：坏角色会让 bss 质量把 drom 锚成
        // ram，并让一块 PSRAM BSS 在 drom/extern 两个 region 里重复计入。
        const regions = [
            region('drom0_0_seg', 0x3c000020, 0x2000000),
            region('extern_ram_seg', 0x3c000020, 0x2000000),
            region('dram0_0_seg', 0x3fc88000, 0x53700),
        ];
        const symbols = [
            sym({ name: 'ro', kind: 'rodata', addr: 0x3c010120, size: 0x20 }),
            sym({ name: 'ext', kind: 'bss', addr: 0x3c020000, size: 0x40 }),
            sym({ name: 'int', kind: 'bss', addr: 0x3fc88000, size: 0x10 }),
        ];
        assignRegionRoles(regions, symbols);
        expect(regions.map((r) => r.role)).toEqual(['flash', 'ram', 'ram']);
        const doc = {
            format: 'gnu-ld',
            file: 't',
            regions,
            symbols,
            totals: { flash: 0, ram: 0, keptCount: 0, discardedCount: 0, fillTotal: 0, kindTotals: { code: 0, rodata: 0, data: 0, bss: 0, meta: 0, pad: 0, other: 0 }, regions: [] },
            warnings: [],
        } as unknown as MapDocument;
        const totals = computeStorageAndTotals(doc);
        expect(totals.flash).toBe(0x20);
        expect(totals.ram).toBe(0x50);
        const used = Object.fromEntries(totals.regions.map((r) => [r.region.name, r.used]));
        expect(used).toEqual({ drom0_0_seg: 0x20, extern_ram_seg: 0x40, dram0_0_seg: 0x10 });
    });

    it('resolves an aliased data window to RAM, not the flash alias', () => {
        // 同址别名窗口里同时有 flash 与 ram 两个 region：data 的运行时副本
        // 在 PSRAM（ram），载像在 flash。按声明顺序 first-match 会只记
        // flash，把这块 RAM 漏掉。
        const regions = [
            region('drom0_0_seg', 0x3c000020, 0x2000000),
            region('extern_ram_seg', 0x3c000020, 0x2000000),
        ];
        const symbols = [sym({ name: 'ps', kind: 'data', addr: 0x3c020000, size: 0x10 })];
        assignRegionRoles(regions, symbols);
        expect(regions.map((r) => r.role)).toEqual(['flash', 'ram']);
        const doc = {
            format: 'gnu-ld',
            file: 't',
            regions,
            symbols,
            totals: { flash: 0, ram: 0, keptCount: 0, discardedCount: 0, fillTotal: 0, kindTotals: { code: 0, rodata: 0, data: 0, bss: 0, meta: 0, pad: 0, other: 0 }, regions: [] },
            warnings: [],
        } as unknown as MapDocument;
        const totals = computeStorageAndTotals(doc);
        expect(totals.flash).toBe(0x10);
        expect(totals.ram).toBe(0x10);
        expect(symbols[0].storage).toEqual(['flash', 'ram']);
    });

    it('trusts the newer IDF region skeleton (C6/H2/P4 naming generation)', () => {
        // esp-idf 5.5：c5/c6/c61/h2/h21/h4/p4 用 irom_seg/drom_seg/sram_seg/
        // lp_ram_seg/lp_reserved_seg（irom/drom 在 c6/p4 还同址）。sram_seg
        // 是 IRAM+DRAM 合一的 RWX 区，IRAM 代码多于 IROM 时若靠质量投票会
        // 被判 flash —— 与经典 ESP32 同一个错误，只是换了段名。
        const regions = [
            region('irom_seg', 0x42000020, 0x400000),
            region('drom_seg', 0x42000020, 0x400000),
            region('sram_seg', 0x40800000, 0x6e610),
            region('lp_ram_seg', 0x50000000, 0x4000),
            region('lp_reserved_seg', 0x50004000, 0x10),
        ];
        const symbols = [
            sym({ name: 'flash_fn', kind: 'code', addr: 0x42000100, size: 0x40 }),
            sym({ name: 'iram_fn', kind: 'code', addr: 0x40800100, size: 0x50 }),
            sym({ name: 'tab', kind: 'rodata', addr: 0x42010000, size: 0x20 }),
            sym({ name: 'var', kind: 'data', addr: 0x40801000, size: 0x10 }),
            sym({ name: 'buf', kind: 'bss', addr: 0x40802000, size: 0x20 }),
            sym({ name: 'rtc_fn', kind: 'code', addr: 0x50000000, size: 0x8 }),
            sym({ name: 'rtc_data', kind: 'data', addr: 0x50004000, size: 0x8 }),
        ];
        assignRegionRoles(regions, symbols);
        expect(regions.map((r) => r.role)).toEqual(['flash', 'flash', 'ram', 'ram', 'ram']);
        const doc = {
            format: 'gnu-ld',
            file: 't',
            regions,
            symbols,
            totals: { flash: 0, ram: 0, keptCount: 0, discardedCount: 0, fillTotal: 0, kindTotals: { code: 0, rodata: 0, data: 0, bss: 0, meta: 0, pad: 0, other: 0 }, regions: [] },
            warnings: [],
        } as unknown as MapDocument;
        const totals = computeStorageAndTotals(doc);
        // flash = irom 代码 0x40 + IRAM 代码 0x50 + rodata 0x20 + 两份 data 0x18 + RTC 代码 0x8
        expect(totals.flash).toBe(0xd0);
        // ram = IRAM 代码 0x50 + sram data 0x10 + bss 0x20 + RTC 代码 0x8 + RTC data 0x8
        expect(totals.ram).toBe(0x90);
    });
});

describe('region role conflict warnings (review P5, REVIEW-26a5b23)', () => {
    it('warns when the first code symbol lands in a RAM-named region', async () => {
        // i.MX RT 风格：代码链接到 RAM 执行且排最前——单锚点会把 OCRAM
        // 判成 flash，必须有告警信号
        const text = [
            'Memory Configuration',
            '',
            'Name             Origin             Length             Attributes',
            'FLASH            0x60000000 0x00400000 xr',
            'OCRAM            0x20200000 0x00080000 xrw',
            '',
            'Linker script and memory map',
            '',
            '.text            0x20200000       0x10',
            ' .text           0x20200000       0x10 ram_code.o',
            '                0x20200000                ram_func',
            '.bss             0x20201000       0x10',
            ' .bss            0x20201000       0x10 vars.o',
            '                0x20201000                my_var',
        ].join('\n');
        const doc = await parseMapText(text, 'synthetic', { demangle: false, formatOverride: 'gnu-ld' }, undefined);
        const conflict = doc.warnings.filter((w) => w.message.includes('may be swapped'));
        expect(conflict).toHaveLength(1);
        expect(conflict[0].message).toContain('OCRAM');
    });

    it('trusts the anchor when the region name carries both word families (FLASH_DATA)', async () => {
        // 复审四轮 N1（REVIEW-dc30888）：FLASH_DATA / ROM_DATA 命名本身
        // 已表明 flash 意图，不应因含 `data` 词根而误报
        const text = [
            'Memory Configuration',
            '',
            'Name             Origin             Length             Attributes',
            'FLASH_DATA       0x60000000 0x00400000 xr',
            'RAM              0x20200000 0x00080000 xrw',
            '',
            'Linker script and memory map',
            '',
            '.text            0x60000000       0x10',
            ' .text           0x60000000       0x10 code.o',
            '                0x60000000                normal_func',
            '.bss             0x20200000       0x10',
            ' .bss            0x20200000       0x10 vars.o',
            '                0x20200000                my_var',
        ].join('\n');
        const doc = await parseMapText(text, 'synthetic', { demangle: false, formatOverride: 'gnu-ld' }, undefined);
        expect(doc.warnings).toEqual([]);
        const roles = Object.fromEntries(doc.regions.map((r) => [r.name, r.role]));
        expect(roles).toEqual({ FLASH_DATA: 'flash', RAM: 'ram' });
    });

    it('stays silent for conventional FLASH/RAM layouts', async () => {
        const doc = await parseFixture('real/stm32f103-rb-demo-boot.map');
        expect(doc.warnings).toEqual([]);
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

describe('region downgrade (contentless regions)', () => {
    const CFG = (regions: string): string =>
        [
            'Memory Configuration',
            '',
            'Name             Origin             Length             Attributes',
            regions,
            '',
            '',
            'Linker script and memory map',
            '',
        ].join('\n');

    it('keeps the role of a region holding nothing but NOLOAD pads (stack fill)', async () => {
        // RAM contains only a *fill* under a two-line .stack header: a fill
        // inherits its section's kind ('other'), so it proves nothing about
        // the region's alloc semantics — the name-based ram role must stand.
        const doc = await parseMapText(
            CFG('FLASH            0x08000000 0x80000 xr\nRAM              0x20000000 0x10000 xrw') +
                '\n.text           0x08000000       0x10\n .text          0x08000000       0x10 a.o\n' +
                '                0x08000000                main\n' +
                '.stack\n                0x20000000      0x400\n *fill*         0x20000000      0x400\n',
            'synthetic',
            { demangle: false, formatOverride: 'gnu-ld' },
            undefined,
        );
        expect(doc.warnings).toEqual([]);
        expect(doc.regions.find((r) => r.name === 'RAM')!.role).toBe('ram');
        const fill = doc.symbols.find((s) => s.isFill)!;
        expect(fill.storage).toEqual(['ram']);
        expect(doc.totals.ram).toBe(0x400);
    });

    it('still downgrades regions whose only real rows are non-alloc (COPY-style)', async () => {
        // A ROM-named region holding only a custom-section contribution
        // (kind other, e.g. script (COPY) output): downgraded to other, its
        // symbols claim no storage.
        const doc = await parseMapText(
            CFG('FLASH            0x08000000 0x10000 xr\nCFGROM           0x08010000 0x1000  r') +
                '\n.text           0x08000000       0x10\n .text          0x08000000       0x10 a.o\n' +
                '                0x08000000                main\n' +
                '.cfg            0x08010000       0x20\n *(.cfg*)\n' +
                ' shellCommand   0x08010000       0x20 a.o\n                0x08010000                shellCommands\n',
            'synthetic',
            { demangle: false, formatOverride: 'gnu-ld' },
            undefined,
        );
        expect(doc.warnings).toEqual([]);
        expect(doc.regions.find((r) => r.name === 'CFGROM')!.role).toBe('other');
        expect(doc.symbols.find((s) => s.name === 'shellCommands')!.storage).toEqual([]);
        expect(doc.totals.flash).toBe(16);
    });
});
