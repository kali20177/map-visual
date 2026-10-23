import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cliApp';
import { FIXTURES, WASM_DIR, parseFixture } from './helpers';

/**
 * ESP32-S3（Xtensa ESP-IDF）布局回归。
 *
 * 合成 fixture 取自真实 `esp32-s3-demo` 工程的 map 形态，锚定四类只在该
 * 工具链出现的事实：
 *  1. `iram0_0_seg`（0x40374000）是真正可执行的 IRAM（RAM），
 *     `iram0_2_seg`（0x42000020，名字带 iram）是 IROM 的 flash 指令窗口；
 *  2. `.ext_ram.dummy` / `.flash_rodata_dummy` / `.dram0.dummy` /
 *     `.flash.rodata_noload` 是 NOBITS 预留窗口，不是存储；
 *     `.ext_ram.dummy` 与 `.flash_rodata_dummy` 甚至同址重叠；
 *  3. WiFi 的 `.wifirxiram.*` / `.wifi0iram.*` / `.wifislprxiram.*` 是 IRAM
 *     代码，Xtensa `.literal.*` 是只读字面量池，`.xt.*` 是非分配元数据；
 *  4. RTC 段（rtc_slow / rtc_reserved）是 RAM。
 *
 * 真实 map 实测（12.5 MB / 144,476 行）：
 *   flash 1,496,815 B vs 应用镜像 1,496,976 B（差 161 B，0.01%）；
 *   ram 215,406 B vs DRAM .data+.bss 113,212 + IRAM 102,144 + RTC 56
 *   = 215,412 B（差 6 B，来自 `.iram0.text_end` 这类无符号 NOBITS 尾巴）；
 *   treemap 首项为 `.flash.text` 1,100,116 B，预留段不再出现。
 */
const FIXTURE = 'gnuld-xtensa/esp32s3.map';

describe('ESP32-S3 (Xtensa IDF) layout', () => {
    it('mirrors the image: IRAM/IROM roles, flash/ram totals', async () => {
        const doc = await parseFixture(FIXTURE);
        expect(doc.format).toBe('gnu-ld');
        expect(doc.warnings).toEqual([]);
        // flash = .flash.text 0x48（含 WiFi extra/sleep IRAM 各 4 B）
        //       + IRAM 代码/字面量 0x30 + vectors 0x10
        //       + .dram0.data 载像 0x20 + appdesc 0x10 + rodata 0x20 + RTC 0x10
        expect(doc.totals.flash).toBe(0xe8);
        // ram = iram0_0 0x40 + .dram0.data 0x20 + bss 0x20 + RTC 0x10
        expect(doc.totals.ram).toBe(0x90);
        const roles = Object.fromEntries(doc.regions.map((r) => [r.name, r.role]));
        expect(roles).toEqual({
            iram0_0_seg: 'ram',
            iram0_2_seg: 'flash',
            dram0_0_seg: 'ram',
            drom0_0_seg: 'flash',
            rtc_iram_seg: 'ram',
            rtc_reserved_seg: 'ram',
            rtc_slow_seg: 'ram',
            extern_ram_seg: 'ram',
        });
        const used = Object.fromEntries(doc.totals.regions.map((r) => [r.region.name, r.used]));
        expect(used).toEqual({
            iram0_0_seg: 0x40,
            iram0_2_seg: 0x48,
            dram0_0_seg: 0x40,
            drom0_0_seg: 0x30,
            rtc_iram_seg: 0,
            rtc_reserved_seg: 0x8,
            rtc_slow_seg: 0x8,
            extern_ram_seg: 0,
        });
    });

    it('treats dummy/noload windows as address space, not storage', async () => {
        const doc = await parseFixture(FIXTURE);
        const reserve = doc.symbols.filter((s) => s.isReserve);
        expect(reserve.map((s) => s.outSection)).toEqual(
            expect.arrayContaining(['.ext_ram.dummy', '.flash_rodata_dummy', '.dram0.dummy', '.flash.rodata_noload']),
        );
        expect(reserve.every((s) => s.storage.length === 0)).toBe(true);
        // 预留窗口不进 kind 汇总/fill 汇总：只剩 .flash.rodata 里真实的 0x4
        // 对齐填充（合成 fixture 的 dummy 合计 0x1a0）
        expect(doc.totals.kindTotals.pad).toBe(0x4);
        expect(doc.totals.fillTotal).toBe(0x4);
        const noload = doc.symbols.find((s) => s.outSection === '.flash.rodata_noload')!;
        expect(noload.kind).toBe('rodata');
        expect(noload.isReserve).toBe(true);
        expect(noload.storage).toEqual([]);
    });

    it('classifies WiFi IRAM code, Xtensa literal pools and xt.* metadata', async () => {
        const doc = await parseFixture(FIXTURE);
        const wifi = doc.symbols.find((s) => s.name === 'wifi_rx')!;
        expect(wifi.kind).toBe('code');
        // IRAM 代码运行时在 RAM、载像在 flash
        expect(wifi.storage).toEqual(['flash', 'ram']);
        const literal = doc.symbols.find((s) => s.section === '.literal.foo')!;
        expect(literal.kind).toBe('rodata');
        expect(literal.storage).toEqual(['flash', 'ram']);
        // .flash.text 里的 WiFi extra/sleep IRAM 也是代码
        for (const section of ['.wifiextrairam.4', '.wifislpiram.38']) {
            const row = doc.symbols.find((s) => s.section === section)!;
            expect(row.kind).toBe('code');
            expect(row.storage).toEqual(['flash']);
        }
        const xt = doc.symbols.find((s) => s.section === '.xt.prop')!;
        expect(xt.kind).toBe('meta');
        expect(xt.storage).toEqual([]);
        // kind 汇总的 code 包含 WiFi 段，other 不再被它们污染
        expect(doc.totals.kindTotals.code).toBe(0x78);
        expect(doc.totals.kindTotals.other).toBe(0);
    });

    it('keeps placeholder windows out of the CLI treemap', async () => {
        const r = await runCli(['treemap', path.join(FIXTURES, FIXTURE), '--depth', '1'], { wasmDir: WASM_DIR });
        expect(r.code).toBe(0);
        const tree = (JSON.parse(r.out!) as { tree: { name: string; size: number }[] }).tree;
        expect(tree.map((n) => n.name)).not.toContain('.ext_ram.dummy');
        expect(tree.map((n) => n.name)).not.toContain('.flash_rodata_dummy');
        expect(tree.map((n) => n.name)).not.toContain('.dram0.dummy');
        expect(tree[0]).toEqual({ name: '.flash.text', size: 0x48, count: 4 });
    });
});
