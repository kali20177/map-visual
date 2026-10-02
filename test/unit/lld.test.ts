import { describe, expect, it } from 'vitest';
import { parseLld } from '../../src/parser/lld';
import { Warnings } from '../../src/parser/warnings';
import { parseMapText } from '../../src/parser/pipeline';
import { findSym, parseFixture, readFixture } from './helpers';

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
00010500 00010500        4     4 .got
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

    // 以下四份 fixture 均由各自 build.sh（clang[++] 23.1.2 + ld.lld 23.1.2）
    // 生成，真值口径 = llvm-size -B 的 text+data（flash）与 data+bss（ram），
    // 段级对账方法与 real/ 的黄金基准一致。
    describe('real ld.lld C++ fixture (lld/cpp, clang++ 23.1.2)', () => {
        it('matches the ELF truth byte-exactly, alignment fills included', async () => {
            const doc = await parseFixture('lld/cpp/cpp_lld.map');
            expect(doc.format).toBe('lld');
            expect(doc.warnings).toEqual([]);
            // llvm-size -B: text 174 + data 36 = 210 flash; data 36 + bss 12 = 48 ram。
            // 无 fill 合成时会差 5（.text 2 + .data 3 的段间对齐 padding）
            expect(doc.totals.flash).toBe(210);
            expect(doc.totals.ram).toBe(48);
        });

        it('keeps lld-demangled symbol names, recovering mangled from section names', async () => {
            const doc = await parseFixture('lld/cpp/cpp_lld.map');
            // 定论（缺口 #1）：lld map 符号列默认打 demangled 名
            const led = doc.symbols.find((s) => s.name === 'app::Led::render(int)');
            expect(led).toBeDefined();
            expect(led!.size).toBe(0x1c);
            expect(led!.section).toBe('.text._ZN3app3Led6renderEi');
            expect(led!.mangled).toBe('_ZN3app3Led6renderEi');
            const vtable = doc.symbols.find((s) => s.name === 'vtable for app::Widget');
            expect(vtable!.kind).toBe('rodata');
            expect(vtable!.mangled).toBe('_ZTVN3app6WidgetE');
        });

        it('synthesizes *fill* rows for alignment gaps lld never prints', async () => {
            const doc = await parseFixture('lld/cpp/cpp_lld.map');
            const textPad = doc.symbols.find((s) => s.isFill && s.section === '.text');
            expect(textPad!.addr).toBe(0x100f2);
            expect(textPad!.size).toBe(2);
            expect(textPad!.kind).toBe('pad');
            expect(textPad!.storage).toEqual(['flash']);
            const dataPad = doc.symbols.find((s) => s.isFill && s.section === '.data');
            expect(dataPad!.addr).toBe(0x1015d);
            expect(dataPad!.size).toBe(3);
            // 初始化段内的 padding 同样占用 flash 载像
            expect(dataPad!.storage).toEqual(['flash', 'ram']);
            expect(doc.symbols.filter((s) => s.isFill)).toHaveLength(2);
        });

        it('classifies .init_array as other with a load image (flash+ram)', async () => {
            const doc = await parseFixture('lld/cpp/cpp_lld.map');
            const init = doc.symbols.find((s) => s.section === '.init_array');
            expect(init!.kind).toBe('other');
            expect(init!.storage).toEqual(['flash', 'ram']);
        });

        it('strips the Thumb state bit from code-symbol addresses in ARM maps', async () => {
            const doc = await parseFixture('lld/cpp/cpp_lld.map');
            // map prints 0x100f5（bit0 = Thumb 状态）；字节地址是 0x100f4，
            // 与 GNU ld map 的掩码形式一致
            const start = doc.symbols.find((s) => s.name === '_start')!;
            expect(start.addr).toBe(0x100f4);
            // 数据符号保持打印地址原样
            const seed = doc.symbols.find((s) => s.name === 'app::seed')!;
            expect(seed.addr).toBe(0x10148);
        });

        it('demangles the real mangled names through the wasm engine', async () => {
            const doc = await parseFixture('lld/cpp/cpp_lld.map', { demangle: true });
            const led = doc.symbols.find((s) => s.mangled === '_ZN3app3Led6renderEi');
            expect(led!.demangled).toBe('app::Led::render(int)');
            // `.0` 编号后缀的本地静态符号保留打印名（本就是 demangled 形态）
            const scratch = doc.symbols.find((s) => s.name === 'app::scratch (.0)');
            expect(scratch).toBeDefined();
            expect(scratch!.kind).toBe('bss');
        });
    });

    describe('real ld.lld static-library fixture (lld/archive)', () => {
        it('splits archive members and matches the ELF truth', async () => {
            const doc = await parseFixture('lld/archive/archive_lld.map');
            expect(doc.warnings).toEqual([]);
            // llvm-size -B: text 484 + data 0 = 484 flash; data 0 + bss 64 = 64 ram
            expect(doc.totals.flash).toBe(484);
            expect(doc.totals.ram).toBe(64);
            // 定论（缺口 #2）：成员 In 行形如 `libnet.a(net.o):(.text.net_send)`
            const send = doc.symbols.find((s) => s.name === 'net_send')!;
            expect(send.archive).toBe('libnet.a');
            expect(send.member).toBe('net.o');
            expect(send.object).toBe('libnet.a(net.o)');
            expect(send.size).toBe(0x86);
            const crc = doc.symbols.find((s) => s.name === 'crc32')!;
            expect(crc.member).toBe('crc.o');
            // 未被引用的成员（audio.o）与成员内被 gc 的函数从不打印
            expect(doc.symbols.some((s) => s.name === 'audio_mix')).toBe(false);
            expect(doc.symbols.some((s) => s.name === 'net_unused')).toBe(false);
            // 成员段对齐到 4：net_send 止于半字中间，crc32 从字对齐处开始
            const pad = doc.symbols.find((s) => s.isFill)!;
            expect(pad!.size).toBe(2);
            expect(pad!.section).toBe('.text');
            expect(doc.totals.fillTotal).toBe(2);
        });
    });

    describe('real ld.lld gc-sections multi-object fixture (lld/gc)', () => {
        it('parses COMMON rows as bss and matches the ELF truth', async () => {
            const doc = await parseFixture('lld/gc/gc_lld.map');
            expect(doc.warnings).toEqual([]);
            // llvm-size -B: text 134 + data 16 = 150 flash; data 16 + bss 24 = 40 ram
            expect(doc.totals.flash).toBe(150);
            expect(doc.totals.ram).toBe(40);
            // 定论（缺口 #3）：COMMON 符号按 `util.o:(COMMON)` 逐符号一行
            const ca = doc.symbols.find((s) => s.name === 'common_a')!;
            expect(ca.section).toBe('COMMON');
            expect(ca.kind).toBe('bss');
            expect(ca.storage).toEqual(['ram']);
            expect(ca.object).toBe('util.o');
            // --gc-sections 回收的符号静默缺席
            expect(doc.symbols.some((s) => s.name === 'util_unused')).toBe(false);
            expect(doc.symbols.some((s) => s.name === 'unused_table')).toBe(false);
        });

        it('keeps $d data-in-code mapping symbols and synthesizes .data padding', async () => {
            const doc = await parseFixture('lld/gc/gc_lld.map');
            const d = doc.symbols.find((s) => s.name === '$d')!;
            expect(d.size).toBe(0);
            expect(d.section).toBe('.text.poolkeeper');
            // 外层符号覆盖代码+数据（0xe = 14 B 含内联汇编的 .word）
            const pk = doc.symbols.find((s) => s.name === 'poolkeeper')!;
            expect(pk.size).toBe(0xe);
            // align-1 pad_probe 之后 align-8 ll_probe 之前：.data 里 7 字节 padding
            const pad = doc.symbols.find((s) => s.isFill)!;
            expect(pad!.addr).toBe(0x10121);
            expect(pad!.size).toBe(7);
            expect(pad!.storage).toEqual(['flash', 'ram']);
        });
    });

    describe('real ld.lld full-LTO fixture (lld/lto)', () => {
        it('flags the synthetic .elf.lto.o object as LTO and matches the ELF truth', async () => {
            const doc = await parseFixture('lld/lto/lto_lld.map');
            expect(doc.warnings).toEqual([]);
            // llvm-size -B: text 42 + data 8 = 50 flash; data 8 + bss 0 = 8 ram
            expect(doc.totals.flash).toBe(50);
            expect(doc.totals.ram).toBe(8);
            // 定论（缺口 #4）：full LTO 把输入改名为 `<输出名>.elf.lto.o`
            const main = findSym(doc, 'main')!;
            expect(main.object).toBe('lto.elf.lto.o');
            expect(main.isLto).toBe(true);
            // 5 = main/gate/lto_data + $t 映射符号 + .ARM.attributes 段级行（同属合成对象）
            expect(doc.symbols.filter((s) => s.isLto)).toHaveLength(5);
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
        expect(got!.line).toBe(17);
    });
});
