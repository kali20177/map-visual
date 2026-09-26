import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cliApp';
import type { CliRunResult } from '../../src/cliApp';
import type { SymbolRecord } from '../../src/types';
import { FIXTURES, ROOT, WASM_DIR, parseFixture } from './helpers';

/**
 * CLI（M6，docs/CLI.md）契约测试：黄金基准数字、过滤/排序语义、treemap
 * 分区不变量、diff 聚合与退出码。直测 runCli（纯返回值，不 spawn 进程）；
 * dist 产物的冒烟在 CI 的 CLI smoke 步骤覆盖。
 */

const ENV = { wasmDir: WASM_DIR };
const fx = (rel: string): string => path.join(FIXTURES, rel);
const RB_DEMO = fx('real/stm32f103-rb-demo-boot.map');
const ZEPHYR = fx('real/zephyr-nucleo-f103rb.map');
const GC_MAP = fx('gnuld-arm/firmware_sections_gc.map');

interface TotalsJson {
    flash: number;
    ram: number;
    keptCount: number;
    discardedCount: number;
    kindTotals: Record<string, number>;
    regions: { name: string; used: number; usage: number }[];
}
interface SummaryJson {
    tool: string;
    version: string;
    command: string;
    file: string;
    format: string;
    totals: TotalsJson;
    warnings: unknown[];
}
interface SymbolsJson {
    command: string;
    count: number;
    totals: TotalsJson;
    symbols: SymbolRecord[];
}
interface TreeNodeJson {
    name: string;
    size: number;
    count: number;
    children?: TreeNodeJson[];
}
interface DiffJson {
    fileA: string;
    fileB: string;
    summary: { added: number; removed: number; changed: number; deltaFlash: number; deltaRam: number };
    rows: { key: string; status: string; delta: number }[];
    totalsA: TotalsJson;
    totalsB: TotalsJson;
    warnings: { message: string }[];
}

function jsonOut<T>(r: CliRunResult): T {
    expect(r.code).toBe(0);
    expect(r.out).toBeDefined();
    return JSON.parse(r.out!) as T;
}

function expectErr(r: CliRunResult, code: number, kind?: string): void {
    expect(r.code).toBe(code);
    expect(r.err).toBeDefined();
    if (code === 2) {
        // usage 错误是人类可读格式 + Usage 帮助（docs/CLI.md §3）
        expect(r.err).toContain('Usage:');
        return;
    }
    // MapParseError.kind 类错误必须是单行 JSON
    const parsed = JSON.parse(r.err!.trim()) as { error: { kind: string; message: string } };
    expect(parsed.error.message).toBeTruthy();
    if (kind) {
        expect(parsed.error.kind).toBe(kind);
    }
}

const pkgVersion = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

describe('cli summary — real-world goldens', () => {
    it('rb-demo boot matches the ELF segment truth (7648/6360)', async () => {
        const j = jsonOut<SummaryJson>(await runCli(['summary', RB_DEMO], ENV));
        expect(j.tool).toBe('mapvisual');
        expect(j.command).toBe('summary');
        expect(j.format).toBe('gnu-ld');
        expect(j.totals.flash).toBe(7648);
        expect(j.totals.ram).toBe(6360);
        expect(j.warnings).toEqual([]);
        expect(j.version).toBe(pkgVersion);
    });

    it('zephyr matches the ELF truth (77256/16054) despite dot-less sections', async () => {
        const j = jsonOut<SummaryJson>(await runCli(['summary', ZEPHYR], ENV));
        expect(j.totals.flash).toBe(77256);
        expect(j.totals.ram).toBe(16054);
    });

    it('gnuld-arm gc fixture matches --print-memory-usage (4152/260)', async () => {
        const j = jsonOut<SummaryJson>(await runCli(['summary', GC_MAP], ENV));
        expect(j.totals.flash).toBe(4152);
        expect(j.totals.ram).toBe(260);
        const flash = j.totals.regions.find((r) => r.name === 'FLASH');
        expect(flash?.used).toBe(4152);
        expect(flash?.usage).toBeGreaterThan(0);
    });

    it('parses every fixture in the corpus without error', async () => {
        const maps = fs
            .readdirSync(FIXTURES, { recursive: true, encoding: 'utf8' })
            .filter((f) => f.endsWith('.map'));
        expect(maps.length).toBeGreaterThanOrEqual(22);
        for (const rel of maps) {
            const r = await runCli(['summary', path.join(FIXTURES, rel)], ENV);
            const j = JSON.parse(r.out!) as SummaryJson;
            expect(r.code, rel).toBe(0);
            expect(['gnu-ld', 'lld'], rel).toContain(j.format);
        }
    });

    it('renders a Markdown table with --md', async () => {
        const r = await runCli(['summary', RB_DEMO, '--md'], ENV);
        expect(r.code).toBe(0);
        expect(r.out).toContain('| Region |');
        expect(r.out).toContain('FLASH');
        expect(r.out).toContain('7648');
    });
});

describe('cli symbols — filtering and sorting', () => {
    it('--kind code --top 5 returns 5 code rows sorted by size desc', async () => {
        const j = jsonOut<SymbolsJson>(
            await runCli(['symbols', GC_MAP, '--kind', 'code', '--top', '5'], ENV),
        );
        expect(j.count).toBe(5);
        expect(j.symbols.every((s) => s.kind === 'code')).toBe(true);
        for (let i = 1; i < j.symbols.length; i++) {
            expect(j.symbols[i - 1].size).toBeGreaterThanOrEqual(j.symbols[i].size);
        }
    });

    it('defaults fold meta and hide discarded (webview parity)', async () => {
        const j = jsonOut<SymbolsJson>(await runCli(['symbols', RB_DEMO], ENV));
        expect(j.symbols.some((s) => s.kind === 'meta')).toBe(false);
        expect(j.symbols.every((s) => s.status === 'kept')).toBe(true);
        // rb-demo 确有 meta/discarded 内容，默认折叠不是空集退化的巧合
        expect(j.totals.kindTotals.meta).toBeGreaterThan(0);
        expect(j.totals.discardedCount).toBeGreaterThan(0);
    });

    it('--status discarded opts back in', async () => {
        const j = jsonOut<SymbolsJson>(
            await runCli(['symbols', RB_DEMO, '--status', 'discarded'], ENV),
        );
        expect(j.symbols.length).toBeGreaterThan(0);
        expect(j.symbols.every((s) => s.status === 'discarded')).toBe(true);
    });

    it('--filter matches mangled and demangled names', async () => {
        // no_demangle fixture 的符号行是 mangled 形态，经 WASM demangle 后可按 demangled 命中
        const j = jsonOut<SymbolsJson>(
            await runCli(['symbols', fx('gnuld-arm/firmware_no_demangle.map'), '--filter', 'add3'], ENV),
        );
        expect(j.symbols.length).toBeGreaterThan(0);
        expect(j.symbols.some((s) => s.demangled === 'util::add3(int, int, int)')).toBe(true);
        expect(j.symbols.every((s) => `${s.name}\n${s.demangled ?? ''}\n${s.mangled ?? ''}`.includes('add3'))).toBe(true);
    });

    it('--no-demangle keeps mangled names untouched', async () => {
        const j = jsonOut<SymbolsJson>(
            await runCli(['symbols', fx('gnuld-arm/firmware_no_demangle.map'), '--no-demangle'], ENV),
        );
        expect(j.symbols.length).toBeGreaterThan(0);
        expect(j.symbols.every((s) => s.demangled === null)).toBe(true);
    });
});

describe('cli treemap — partition invariant', () => {
    it('children sum to parents at every level and match kept non-meta total', async () => {
        const j = jsonOut<{ tree: TreeNodeJson[] }>(
            await runCli(['treemap', RB_DEMO], ENV),
        );
        const check = (nodes: TreeNodeJson[]): number => {
            let total = 0;
            for (const n of nodes) {
                if (n.children && n.children.length > 0) {
                    expect(check(n.children)).toBe(n.size);
                }
                total += n.size;
            }
            return total;
        };
        const treeSum = check(j.tree);
        const doc = await parseFixture('real/stm32f103-rb-demo-boot.map');
        const expected = doc.symbols
            .filter((s) => s.status === 'kept' && s.kind !== 'meta')
            .reduce((a, s) => a + s.size, 0);
        expect(treeSum).toBe(expected);
        // 同级按 size 降序（treemap 约定）
        for (const n of j.tree) {
            for (let i = 1; i < (n.children ?? []).length; i++) {
                expect(n.children![i - 1].size).toBeGreaterThanOrEqual(n.children![i].size);
            }
        }
    });

    it('respects --depth and --by', async () => {
        const d1 = jsonOut<{ tree: TreeNodeJson[] }>(await runCli(['treemap', RB_DEMO, '--depth', '1'], ENV));
        expect(d1.tree.every((n) => n.children === undefined)).toBe(true);
        const d2 = jsonOut<{ tree: TreeNodeJson[] }>(
            await runCli(['treemap', RB_DEMO, '--depth', '2', '--by', 'kind'], ENV),
        );
        expect(d2.tree.length).toBeGreaterThan(0);
        expect(d2.tree.every((n) => (n.children ?? []).every((c) => c.children === undefined))).toBe(true);
    });
});

describe('cli diff', () => {
    it('aggregates match totals and rows exclude "same" by default', async () => {
        const j = jsonOut<DiffJson>(
            await runCli(['diff', fx('gnuld-arm/firmware_basic.map'), GC_MAP], ENV),
        );
        expect(j.summary.deltaFlash).toBe(j.totalsB.flash - j.totalsA.flash);
        expect(j.summary.deltaRam).toBe(j.totalsB.ram - j.totalsA.ram);
        expect(j.rows.every((r) => r.status !== 'same')).toBe(true);
    });

    it('--status same makes row-based counts reproducible from the payload', async () => {
        const j = jsonOut<DiffJson>(
            await runCli(
                [
                    'diff', fx('gnuld-arm/firmware_basic.map'), GC_MAP,
                    '--status', 'added', '--status', 'removed', '--status', 'changed', '--status', 'same',
                ],
                ENV,
            ),
        );
        expect(j.summary.added).toBe(j.rows.filter((r) => r.status === 'added').length);
        expect(j.summary.removed).toBe(j.rows.filter((r) => r.status === 'removed').length);
        expect(j.summary.changed).toBe(j.rows.filter((r) => r.status === 'changed').length);
    });

    it('--top truncates the |Δ|-sorted rows', async () => {
        const full = jsonOut<DiffJson>(await runCli(['diff', fx('gnuld-arm/firmware_basic.map'), GC_MAP], ENV));
        const top = jsonOut<DiffJson>(
            await runCli(['diff', fx('gnuld-arm/firmware_basic.map'), GC_MAP, '--top', '10'], ENV),
        );
        expect(top.rows.length).toBe(10);
        // diff.rows 按 |Δ| 降序，截断即取影响最大的前 10 行
        expect(top.rows).toEqual(full.rows.slice(0, 10));
    });

    it('prefixes per-side warnings', async () => {
        const j = jsonOut<DiffJson>(await runCli(['diff', GC_MAP, GC_MAP], ENV));
        expect(j.warnings.every((w) => w.message.startsWith('A: ') || w.message.startsWith('B: '))).toBe(true);
    });
});

describe('cli errors and usage', () => {
    it('maps MapParseError kinds to exit codes with JSON on stderr', async () => {
        expectErr(await runCli(['summary', path.join(os.tmpdir(), 'mapvisual-no-such.map')], ENV), 3, 'notfound');
        expectErr(await runCli(['summary'], ENV), 2);
    });

    it('detects-but-unsupported formats exit 4', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapvisual-cli-'));
        try {
            const arm = path.join(dir, 'armlink.map');
            fs.writeFileSync(arm, 'Section Cross References\n\nImage component sizes\n');
            expectErr(await runCli(['summary', arm], ENV), 4, 'unsupported');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('JS sourcemaps exit 6', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapvisual-cli-'));
        try {
            const jsmap = path.join(dir, 'bundle.js.map');
            fs.writeFileSync(jsmap, '{"version":3,"sources":[],"names":[],"mappings":"AAAA"}');
            expectErr(await runCli(['summary', jsmap], ENV), 6, 'json');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('rejects bad flags and unknown commands with usage help', async () => {
        const bad = await runCli(['symbols', GC_MAP, '--sort', 'bogus'], ENV);
        expect(bad.code).toBe(2);
        expect(bad.err).toContain('Usage:');
        const cmd = await runCli(['bogus'], ENV);
        expect(cmd.code).toBe(2);
        expect(cmd.err).toContain("unknown command 'bogus'");
        const re = await runCli(['symbols', GC_MAP, '--section', '('], ENV);
        expect(re.code).toBe(2);
        const depth = await runCli(['treemap', RB_DEMO, '--depth', '9'], ENV);
        expect(depth.code).toBe(2);
        const extra = await runCli(['summary', RB_DEMO, 'another.map'], ENV);
        expect(extra.code).toBe(2);
    });

    it('--version prints the package version', async () => {
        const r = await runCli(['--version'], ENV);
        expect(r.code).toBe(0);
        expect(r.out).toBe(`mapvisual ${pkgVersion}\n`);
    });
});
