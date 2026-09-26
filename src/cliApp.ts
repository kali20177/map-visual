import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { parseMapFile, MapParseError } from './parser/pipeline';
import type { ParseOptions } from './parser/pipeline';
import { diffDocuments } from './analysis/diff';
import type { DiffRow, MapDocument, MapTotals, SymbolKind, SymbolRecord } from './types';

/**
 * MapVisual CLI（M6，docs/CLI.md）——AI / 脚本通道。
 *
 * 纯命令实现：不触碰 process（无 stdout/exit 副作用），vitest 直测，未来 MCP
 * server 可直接复用；进程入口是 src/cli.ts。属第四运行时，与 worker 同受
 * "禁止 import vscode"约束（eslint no-restricted-imports），且禁止引用宿主
 * 与 webview（dependency-cruiser cli-no-host / cli-no-webview）。
 */

export interface CliRunResult {
    code: number;
    out?: string;
    err?: string;
}

export interface CliEnv {
    /** index_bg.wasm 所在目录：真实二进制传 dist/，测试传 node_modules/gecko-profiler-demangle */
    wasmDir?: string;
    /** 包版本：由 CJS 入口注入（esbuild 把 import.meta 变成空对象，dist 里解析不到） */
    version?: string;
    /** --progress 时的进度出口（入口接到 stderr；未传则 --progress 静默） */
    onProgress?: (stage: string, pct: number) => void;
}

/** 退出码与 MapParseError.kind 对齐（docs/CLI.md §3）；satisfies 保证 kind 增项时必须同步此表 */
const EXIT = {
    ok: 0,
    internal: 1,
    usage: 2,
    notfound: 3,
    unsupported: 4,
    unknown: 5,
    json: 6,
    io: 7,
} as const satisfies Record<'ok' | 'internal' | 'usage' | MapParseError['kind'], number>;

const KINDS: readonly SymbolKind[] = ['code', 'rodata', 'data', 'bss', 'meta', 'pad', 'other'];
/** symbols 默认 kinds：折叠 meta（debug/注释非存储），对齐 webview 默认视图（FORMATS §1.6） */
const DEFAULT_KINDS: ReadonlySet<SymbolKind> = new Set(KINDS.filter((k) => k !== 'meta'));
const SYMBOL_STATUSES = ['kept', 'discarded'] as const;
const DIFF_STATUSES = ['added', 'removed', 'changed', 'same'] as const;
const SORTS = ['size', 'addr', 'name'] as const;
const TREEMAP_BY = ['section', 'object', 'kind'] as const;

const USAGE = `mapvisual — visualize embedded linker map files (GNU ld / LLVM lld)

Usage:
  mapvisual summary <file>
  mapvisual symbols <file> [--kind K]... [--status kept|discarded]... [--section RE]
                    [--object RE] [--filter TEXT] [--min-size N]
                    [--sort size|addr|name] [--top N]
  mapvisual treemap <file> [--by section|object|kind] [--depth 1|2|3]
  mapvisual diff <fileA> <fileB> [--status added|removed|changed|same]...
                 [--min-delta N] [--top N]

Global options:
  --format auto|gnu-ld|lld   force the map format instead of auto-detection
  --no-demangle              keep mangled names (skip the WASM demangler)
  --md                       Markdown table output instead of JSON
  --progress                 parse progress lines on stderr
  -h, --help                 this help
  -v, --version              print version

JSON goes to stdout; errors as single-line JSON on stderr.
Exit codes: 0 ok | 1 internal | 2 usage | 3 not-found | 4 unsupported |
            5 unknown-format | 6 json | 7 io`;

const PARSE_ARGS_OPTS = {
    format: { type: 'string' },
    'no-demangle': { type: 'boolean' },
    md: { type: 'boolean' },
    progress: { type: 'boolean' },
    kind: { type: 'string', multiple: true },
    status: { type: 'string', multiple: true },
    section: { type: 'string' },
    object: { type: 'string' },
    filter: { type: 'string' },
    'min-size': { type: 'string' },
    sort: { type: 'string' },
    top: { type: 'string' },
    by: { type: 'string' },
    depth: { type: 'string' },
    'min-delta': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
} as const;

type ArgValues = Record<string, string | boolean | string[] | undefined>;

class UsageError extends Error {}

function cliVersion(env: CliEnv): string {
    if (env.version) {
        return env.version;
    }
    try {
        // vitest（真 ESM）路径：源码上跳一级到 package.json；dist 里 import.meta 是
        // esbuild 的空对象 shim，靠入口注入的 env.version 兜底
        return createRequire(import.meta.url)('../package.json').version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

function toJson(x: unknown): string {
    return JSON.stringify(x, null, 2) + '\n';
}

function errJson(kind: string, message: string): string {
    return JSON.stringify({ error: { kind, message } }) + '\n';
}

function asStrings(v: ArgValues[string]): string[] {
    if (v == null) {
        return [];
    }
    return Array.isArray(v) ? v : [String(v)];
}

function asInt(v: ArgValues[string], flag: string): number | undefined {
    if (v == null) {
        return undefined;
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
        throw new UsageError(`--${flag} expects a non-negative integer, got '${String(v)}'`);
    }
    return n;
}

function validateList<T extends string>(vals: string[], allowed: readonly T[], flag: string): T[] | undefined {
    if (vals.length === 0) {
        return undefined;
    }
    return vals.map((x) => {
        if (!(allowed as readonly string[]).includes(x)) {
            throw new UsageError(`--${flag} must be one of ${allowed.join('|')}, got '${x}'`);
        }
        return x as T;
    });
}

function validateSingle<T extends string>(v: ArgValues[string], allowed: readonly T[], flag: string, dflt: T): T {
    if (v == null) {
        return dflt;
    }
    const s = String(v);
    if (!(allowed as readonly string[]).includes(s)) {
        throw new UsageError(`--${flag} must be one of ${allowed.join('|')}, got '${s}'`);
    }
    return s as T;
}

function compileRe(v: ArgValues[string], flag: string): RegExp | undefined {
    if (v == null) {
        return undefined;
    }
    try {
        return new RegExp(String(v));
    } catch (e) {
        throw new UsageError(`--${flag} is not a valid regular expression: ${(e as Error).message}`);
    }
}

function parseOpts(v: ArgValues): ParseOptions {
    const format = v.format == null ? 'auto' : String(v.format);
    if (format !== 'auto' && format !== 'gnu-ld' && format !== 'lld') {
        throw new UsageError(`--format must be auto|gnu-ld|lld, got '${format}'`);
    }
    return { demangle: !v['no-demangle'], formatOverride: format };
}

function requirePos(pos: string[], i: number, what: string): string {
    const val = pos[i];
    if (!val) {
        throw new UsageError(`missing required argument ${what}`);
    }
    return val;
}

function progressOf(v: ArgValues, env: CliEnv): ((stage: string, pct: number) => void) | undefined {
    return v.progress ? env.onProgress : undefined;
}

// ── 输出构造 ──

function envelope(command: string, version: string): { tool: string; version: string; command: string } {
    return { tool: 'mapvisual', version, command };
}

function flattenTotals(t: MapTotals): object {
    return {
        flash: t.flash,
        ram: t.ram,
        keptCount: t.keptCount,
        discardedCount: t.discardedCount,
        fillTotal: t.fillTotal,
        kindTotals: t.kindTotals,
        regions: t.regions.map(({ region, used }) => ({
            name: region.name,
            role: region.role,
            origin: region.origin,
            length: region.length,
            attrs: region.attrs,
            used,
            usage: region.length > 0 ? used / region.length : 0,
        })),
    };
}

function summaryPayload(doc: MapDocument, version: string): object {
    return {
        ...envelope('summary', version),
        file: doc.file,
        format: doc.format,
        totals: flattenTotals(doc.totals),
        warnings: doc.warnings,
    };
}

interface SymbolQuery {
    kinds: ReadonlySet<SymbolKind>;
    statuses?: ReadonlySet<'kept' | 'discarded'>;
    sectionRe?: RegExp;
    objectRe?: RegExp;
    filterText?: string;
    minSize: number;
    sort: (typeof SORTS)[number];
    top?: number;
}

function filterSymbols(doc: MapDocument, q: SymbolQuery): SymbolRecord[] {
    const rows = doc.symbols.filter((s) => {
        if (!q.kinds.has(s.kind)) {
            return false;
        }
        if (q.statuses && !q.statuses.has(s.status)) {
            return false;
        }
        if (q.sectionRe && !q.sectionRe.test(s.section)) {
            return false;
        }
        if (q.objectRe && !q.objectRe.test(s.object)) {
            return false;
        }
        if (q.filterText) {
            const hay = `${s.name}\n${s.demangled ?? ''}\n${s.mangled ?? ''}`.toLowerCase();
            if (!hay.includes(q.filterText.toLowerCase())) {
                return false;
            }
        }
        return s.size >= q.minSize;
    });
    const byName = (s: SymbolRecord): string => (s.demangled ?? s.name).toLowerCase();
    rows.sort((a, b) => {
        switch (q.sort) {
            case 'addr':
                return a.addr - b.addr;
            case 'name':
                return byName(a).localeCompare(byName(b));
            case 'size':
                // size 默认降序（"谁最大"），同尺寸按地址稳定排序
                return a.size !== b.size ? b.size - a.size : a.addr - b.addr;
        }
    });
    return q.top != null ? rows.slice(0, q.top) : rows;
}

function symbolsPayload(doc: MapDocument, version: string, rows: SymbolRecord[]): object {
    return {
        ...envelope('symbols', version),
        file: doc.file,
        format: doc.format,
        count: rows.length,
        totals: flattenTotals(doc.totals),
        symbols: rows,
        warnings: doc.warnings,
    };
}

interface TreeNode {
    name: string;
    size: number;
    /** 原始行数（同名符号合并、pad 行计入），非去重符号名数 */
    count: number;
    children?: TreeNode[];
}

function baseName(p: string): string {
    const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return slash >= 0 ? p.slice(slash + 1) : p;
}

function objectKey(s: SymbolRecord): string {
    // 与 webview 分组同语义（model.ts groupKeyOf 'object'）：归档成员显示为 库 › 成员
    return s.member ? `${baseName(s.archive ?? '')} › ${s.member}` : baseName(s.object) || '(none)';
}

function sumOf(nodes: TreeNode[]): number {
    return nodes.reduce((a, n) => a + n.size, 0);
}

function buildTree(doc: MapDocument, by: (typeof TREEMAP_BY)[number], depth: number): TreeNode[] {
    // 三层键 k1 → k2 → 叶（同名符号合并，count 累计原始行数）；计入 pad/fill
    //（占空间），折叠 meta，对齐 webview 默认视图与 realmap 的"kept 非 meta 平铺不变量"。
    // by=section 用输出段名 outSection（linker script 粒度）——输入段名（`.text.foo`）
    // 与输出段头会把两种粒度混进同一层，且与输出段同名的键只剩 fill 残渣；
    // 无输出段上下文的行回落到 section（loose fills、discarded 列表）。
    const levels = new Map<string, Map<string, Map<string, { size: number; rows: number }>>>();
    for (const s of doc.symbols) {
        if (s.status !== 'kept' || s.kind === 'meta') {
            continue;
        }
        const k1 =
            by === 'kind' ? s.kind : by === 'object' ? objectKey(s) : (s.outSection ?? s.section);
        const k2 = by === 'section' ? objectKey(s) : s.section;
        const leaf = s.demangled ?? s.name;
        const l2 = levels.get(k1) ?? new Map<string, Map<string, { size: number; rows: number }>>();
        levels.set(k1, l2);
        const l3 = l2.get(k2) ?? new Map<string, { size: number; rows: number }>();
        l2.set(k2, l3);
        const cur = l3.get(leaf) ?? { size: 0, rows: 0 };
        cur.size += s.size;
        cur.rows += 1;
        l3.set(leaf, cur);
    }

    const leavesOf = (m: Map<string, { size: number; rows: number }>): TreeNode[] =>
        [...m.entries()]
            .map(([name, { size, rows }]) => ({ name, size, count: rows }))
            .sort((a, b) => b.size - a.size);

    const nodes = [...levels.entries()]
        .map(([k1, l2map]) => {
            const children = [...l2map.entries()]
                .map(([k2, leafMap]) => {
                    const leaves = leavesOf(leafMap);
                    return { name: k2, size: sumOf(leaves), count: leaves.length, children: leaves };
                })
                .sort((a, b) => b.size - a.size);
            return {
                name: k1,
                size: sumOf(children),
                count: children.reduce((a, c) => a + c.count, 0),
                children,
            };
        })
        .sort((a, b) => b.size - a.size);

    if (depth <= 1) {
        return nodes.map(({ name, size, count }) => ({ name, size, count }));
    }
    if (depth === 2) {
        return nodes.map((n) => ({
            name: n.name,
            size: n.size,
            count: n.count,
            children: n.children?.map(({ name, size, count }) => ({ name, size, count })),
        }));
    }
    return nodes;
}

function treemapPayload(doc: MapDocument, version: string, by: (typeof TREEMAP_BY)[number], depth: number): object {
    return {
        ...envelope('treemap', version),
        file: doc.file,
        format: doc.format,
        by,
        depth,
        tree: buildTree(doc, by, depth),
        warnings: doc.warnings,
    };
}

// ── --md 投影（人读；JSON 是给机器的主通道）──

function mdEscape(s: string): string {
    return s.replace(/\|/g, '\\|');
}

function hexAddr(n: number): string {
    return '0x' + n.toString(16);
}

function summaryMd(doc: MapDocument): string {
    const t = doc.totals;
    const lines = [
        `## MapVisual summary — ${doc.file} (${doc.format})`,
        '',
        `**Flash ${t.flash} B · RAM ${t.ram} B** — kept ${t.keptCount}, discarded ${t.discardedCount}, fill ${t.fillTotal} B`,
        '',
        '| Region | Role | Used | Length | Usage |',
        '|---|---|---|---|---|',
    ];
    for (const { region, used } of t.regions) {
        const pct = region.length > 0 ? `${((used / region.length) * 100).toFixed(1)}%` : '-';
        lines.push(`| ${mdEscape(region.name)} | ${region.role} | ${used} | ${region.length} | ${pct} |`);
    }
    lines.push('', '| Kind | Bytes |', '|---|---|');
    for (const [kind, size] of Object.entries(t.kindTotals)) {
        lines.push(`| ${kind} | ${size} |`);
    }
    if (doc.warnings.length > 0) {
        lines.push('', '**Warnings**', '');
        for (const w of doc.warnings) {
            lines.push(`- ${w.message}${w.count > 1 ? ` (×${w.count})` : ''}`);
        }
    }
    return lines.join('\n') + '\n';
}

function symbolsMd(rows: SymbolRecord[]): string {
    const lines = ['| Size | Name | Kind | Section | Object | Address |', '|---|---|---|---|---|---|'];
    for (const s of rows) {
        lines.push(`| ${s.size} | ${mdEscape(s.demangled ?? s.name)} | ${s.kind} | ${mdEscape(s.section)} | ${mdEscape(s.object)} | ${hexAddr(s.addr)} |`);
    }
    return lines.join('\n') + '\n';
}

function treemapMd(tree: TreeNode[]): string {
    const lines: string[] = [];
    const walk = (nodes: TreeNode[], indent: string): void => {
        for (const n of nodes) {
            lines.push(`${indent}- ${mdEscape(n.name)} — ${n.size} B${n.count > 1 ? ` (${n.count} rows)` : ''}`);
            if (n.children) {
                walk(n.children, indent + '  ');
            }
        }
    };
    walk(tree, '');
    return lines.join('\n') + '\n';
}

function diffMd(rows: DiffRow[], agg: { added: number; removed: number; changed: number; deltaFlash: number; deltaRam: number }): string {
    const lines = [
        `**ΔFlash ${agg.deltaFlash >= 0 ? '+' : ''}${agg.deltaFlash} B · ΔRAM ${agg.deltaRam >= 0 ? '+' : ''}${agg.deltaRam} B** — added ${agg.added}, removed ${agg.removed}, changed ${agg.changed}`,
        '',
        '| Δ | Status | Name | A | B | Object |',
        '|---|---|---|---|---|---|',
    ];
    for (const r of rows) {
        const delta = r.delta > 0 ? `+${r.delta}` : `${r.delta}`;
        lines.push(`| ${delta} | ${r.status} | ${mdEscape(r.name)} | ${r.sizeA} | ${r.sizeB} | ${mdEscape(r.objectB ?? r.objectA ?? '')} |`);
    }
    return lines.join('\n') + '\n';
}

// ── 命令 ──

async function runSummary(pos: string[], v: ArgValues, env: CliEnv, version: string): Promise<CliRunResult> {
    const file = requirePos(pos, 1, '<file>');
    if (pos.length > 2) {
        throw new UsageError(`unexpected argument '${pos[2]}'`);
    }
    const doc = await parseMapFile(file, parseOpts(v), env.wasmDir, progressOf(v, env));
    return { code: EXIT.ok, out: v.md ? summaryMd(doc) : toJson(summaryPayload(doc, version)) };
}

async function runSymbols(pos: string[], v: ArgValues, env: CliEnv, version: string): Promise<CliRunResult> {
    const file = requirePos(pos, 1, '<file>');
    if (pos.length > 2) {
        throw new UsageError(`unexpected argument '${pos[2]}'`);
    }
    const kinds = validateList(asStrings(v.kind), KINDS, '--kind');
    const statuses = validateList(asStrings(v.status), SYMBOL_STATUSES, '--status');
    const q: SymbolQuery = {
        kinds: kinds ? new Set<SymbolKind>(kinds) : DEFAULT_KINDS,
        // 默认对齐 webview：kept only；--status 显式放宽
        statuses: statuses ? new Set(statuses) : new Set(['kept']),
        sectionRe: compileRe(v.section, '--section'),
        objectRe: compileRe(v.object, '--object'),
        filterText: v.filter == null ? undefined : String(v.filter),
        minSize: asInt(v['min-size'], 'min-size') ?? 0,
        sort: validateSingle(v.sort, SORTS, '--sort', 'size'),
        top: asInt(v.top, 'top'),
    };
    const doc = await parseMapFile(file, parseOpts(v), env.wasmDir, progressOf(v, env));
    const rows = filterSymbols(doc, q);
    return { code: EXIT.ok, out: v.md ? symbolsMd(rows) : toJson(symbolsPayload(doc, version, rows)) };
}

async function runTreemap(pos: string[], v: ArgValues, env: CliEnv, version: string): Promise<CliRunResult> {
    const file = requirePos(pos, 1, '<file>');
    if (pos.length > 2) {
        throw new UsageError(`unexpected argument '${pos[2]}'`);
    }
    const by = validateSingle(v.by, TREEMAP_BY, '--by', 'section');
    const depth = asInt(v.depth, 'depth') ?? 3;
    if (depth < 1 || depth > 3) {
        throw new UsageError(`--depth must be 1|2|3, got ${depth}`);
    }
    const doc = await parseMapFile(file, parseOpts(v), env.wasmDir, progressOf(v, env));
    return { code: EXIT.ok, out: v.md ? treemapMd(buildTree(doc, by, depth)) : toJson(treemapPayload(doc, version, by, depth)) };
}

async function runDiff(pos: string[], v: ArgValues, env: CliEnv, version: string): Promise<CliRunResult> {
    const fileA = requirePos(pos, 1, '<fileA>');
    const fileB = requirePos(pos, 2, '<fileB>');
    if (pos.length > 3) {
        throw new UsageError(`unexpected argument '${pos[3]}'`);
    }
    const statusList = validateList(asStrings(v.status), DIFF_STATUSES, '--status');
    const opts = parseOpts(v);
    const onProgress = progressOf(v, env);
    const docA = await parseMapFile(fileA, opts, env.wasmDir, onProgress ? (s, p) => onProgress(`A: ${s}`, p) : undefined);
    const docB = await parseMapFile(fileB, opts, env.wasmDir, onProgress ? (s, p) => onProgress(`B: ${s}`, p) : undefined);
    const diff = diffDocuments(docA, docB);
    const active = new Set<DiffRow['status']>(statusList ?? ['added', 'removed', 'changed']);
    let rows = diff.rows.filter((r) => active.has(r.status));
    const minDelta = asInt(v['min-delta'], 'min-delta');
    if (minDelta != null) {
        rows = rows.filter((r) => Math.abs(r.delta) >= minDelta);
    }
    const top = asInt(v.top, 'top');
    if (top != null) {
        rows = rows.slice(0, top); // diff.rows 已按 |Δ| 降序
    }
    // 聚合计数始终基于全量行——不受 --status/--top 过滤影响
    const agg = {
        added: diff.rows.filter((r) => r.status === 'added').length,
        removed: diff.rows.filter((r) => r.status === 'removed').length,
        changed: diff.rows.filter((r) => r.status === 'changed').length,
        deltaFlash: diff.totalsB.flash - diff.totalsA.flash,
        deltaRam: diff.totalsB.ram - diff.totalsA.ram,
    };
    if (v.md) {
        return { code: EXIT.ok, out: diffMd(rows, agg) };
    }
    return {
        code: EXIT.ok,
        out: toJson({
            ...envelope('diff', version),
            fileA: diff.fileA,
            fileB: diff.fileB,
            summary: agg,
            rows,
            totalsA: flattenTotals(diff.totalsA),
            totalsB: flattenTotals(diff.totalsB),
            warnings: [
                ...docA.warnings.map((w) => ({ ...w, message: `A: ${w.message}` })),
                ...docB.warnings.map((w) => ({ ...w, message: `B: ${w.message}` })),
            ],
        }),
    };
}

export async function runCli(argv: string[], env: CliEnv = {}): Promise<CliRunResult> {
    let pos: string[];
    let v: ArgValues;
    try {
        const parsed = parseArgs({ args: argv, options: PARSE_ARGS_OPTS, allowPositionals: true, strict: true });
        pos = parsed.positionals;
        v = parsed.values as ArgValues;
    } catch (e) {
        return { code: EXIT.usage, err: `mapvisual: ${(e as Error).message}\n\n${USAGE}` };
    }
    try {
        if (v.help) {
            return { code: EXIT.ok, out: USAGE };
        }
        if (v.version) {
            return { code: EXIT.ok, out: `mapvisual ${cliVersion(env)}\n` };
        }
        const version = cliVersion(env);
        switch (pos[0]) {
            case 'summary':
                return await runSummary(pos, v, env, version);
            case 'symbols':
                return await runSymbols(pos, v, env, version);
            case 'treemap':
                return await runTreemap(pos, v, env, version);
            case 'diff':
                return await runDiff(pos, v, env, version);
            default:
                throw new UsageError(pos[0] ? `unknown command '${pos[0]}'` : 'missing command');
        }
    } catch (e) {
        if (e instanceof UsageError) {
            return { code: EXIT.usage, err: `mapvisual: ${e.message}\n\n${USAGE}` };
        }
        if (e instanceof MapParseError) {
            // 运行时兜底：kind 增项而 EXIT 未同步时 undefined 会变成 exit 0（报错报成功）
            return { code: EXIT[e.kind] ?? EXIT.internal, err: errJson(e.kind, e.message) };
        }
        return { code: EXIT.internal, err: errJson('internal', e instanceof Error ? e.message : String(e)) };
    }
}
