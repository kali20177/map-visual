import type { MemoryRegion, SymbolRecord } from '../types';
import { classifySection } from './classify';
import { extractSectionSymbol } from '../demangle';
import type { Warnings } from './warnings';

/**
 * Parser for GNU ld "Linker script and memory map" output
 * (gcc / arm-none-eabi-gcc `-Wl,-Map=...`).
 * Line grammar and size-allocation algorithm: docs/FORMATS.md §1.
 */

// Section tokens usually start with '.', but scripts name output sections
// without a dot too — Zephyr's generated linker script prints `text`,
// `rodata`, `datas`, `bss`, `noinit`, `k_heap_area`, ... at column 0.
const OUTPUT_SECTION_RE =
    /^([A-Za-z_.][^\s]*)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)(?:\s+load address\s+0x([0-9a-fA-F]+))?(?:\s*\(size before (?:relaxing|filtering) 0x[0-9a-fA-F]+\))?(?:\s+[a-zA-Z].*)?\s*$/;
// Section tokens usually start with '.', but scripts collect plain names too
// (`*(shellCommand)` for `__attribute__((section("shellCommand")))` data) and
// COMMON / LARGE_COMMON carry no dot at all.
const CONTRIBUTION_RE = /^\s+([A-Za-z_.][^\s]*)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(.+?)\s*$/;
const CONTINUATION_RE = /^\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(.+?)\s*$/;
// Standalone section-name lines: usually dotted, but dot-less script sections
// wrap the same way once the name grows past the column width — the address
// and object follow on the next line. Wildcard echoes (`*`, `name(...)`),
// `FILL `, `[!provide]` and contribution lines are all matched earlier.
const SECTION_NAME_RE = /^\s+([A-Za-z_.][^\s]*)\s*$/;
const SYMBOL_RE = /^\s+0x([0-9a-fA-F]+)\s+(.+?)\s*$/;
const FILL_RE = /^\s+\*fill\*\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)/;
const DISCARDED_ONE_LINE_RE = /^\s+([^\s]+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(\S+)\s*$/;
const DISCARDED_NAME_RE = /^\s+([^\s0][^\s]*)\s*$/;
const DISCARDED_CONT_RE = /^\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(\S+)\s*$/;
const REGION_RE = /^(\S+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)(?:\s+(\S+))?\s*$/;
const ARCHIVE_MEMBER_RE = /^(.*\.a)\((.+)\)$/;
const HEX_ONLY_RE = /^0x[0-9a-fA-F]+$/;
// wildcard/object-list echo: `*(.text*)`, `*crtbegin.o(.ctors)`, `libc.a(*)` —
// always carries parentheses and never an address
const WILDCARD_ECHO_RE = /^[^\s(]*\([^\s]*\)\s*$/;

interface PendingSymbol {
    addr: number;
    name: string;
    /** 1-based raw map line the symbol was printed on. */
    line: number;
}

interface Contribution {
    section: string;
    vma: number;
    size: number;
    lma: number | null;
    object: string;
    /**
     * 1-based raw map line that prints this contribution's section name — the
     * contribution row itself when name and extent share it, the bare child
     * header (`.text.foo` alone on a line) when ld wrapped them, otherwise the
     * output-section header. Section-level rows (contributions with no symbol
     * lines) are located by name, and the extent line never carries it: GNU ld
     * prints no symbol line for local symbols, so every `static` function
     * under -ffunction-sections lands here.
     */
    sectionLine: number;
    symbols: PendingSymbol[];
}

interface FillEntry {
    vma: number;
    size: number;
    section: string;
    /** Load address of the surrounding output section (initialized sections only). */
    lma: number | null;
    /** 1-based raw map line of the `*fill*` entry. */
    line: number;
}

type OutUnit = { kind: 'group'; group: Contribution } | { kind: 'fill'; fill: FillEntry };

/**
 * Buffered content of one output section header. Units are resolved when the
 * section closes: the real content is the chain of contributions + fills that
 * tiles [vma, vma+size) exactly — anything else on the lines is a stale
 * pre-merge/pre-relax snapshot re-printed by ld under LTO and must be dropped.
 */
interface OutSection {
    name: string;
    vma: number | null;
    size: number | null;
    units: OutUnit[];
}

const unitVma = (u: OutUnit): number => (u.kind === 'group' ? u.group.vma : u.fill.vma);
const unitSize = (u: OutUnit): number => (u.kind === 'group' ? u.group.size : u.fill.size);
/**
 * Carrying symbol lines marks the real placement: when ld re-prints pre-merge
 * snapshots they come without their symbols, so among same-VMA candidates the
 * symbol-bearing unit is the one to keep — regardless of whether the stale
 * re-print sits before or after it in the file.
 */
const bearingSymbols = (u: OutUnit): boolean => u.kind === 'group' && u.group.symbols.length > 0;

const enum State {
    Seek,
    Discarded,
    MemoryConfig,
    MainMap,
}

export function parseObjectField(raw: string): { archive: string | null; member: string | null } {
    const m = ARCHIVE_MEMBER_RE.exec(raw);
    if (m) {
        return { archive: m[1], member: m[2] };
    }
    return { archive: null, member: null };
}

/** Object fields can carry a trailing binutils annotation — strip it. */
export function cleanObjectField(raw: string): string {
    return raw.replace(/\s*\(size before (?:relaxing|filtering) 0x[0-9a-fA-F]+\)\s*$/, '').trim();
}

/**
 * Size allocation inside one contribution (FORMATS §1.4): symbols are
 * consecutive, non-last = next-addr − addr, last = contribution end − addr.
 * Bytes between the contribution start and its first symbol are not claimed
 * by any symbol line (compiler glue, literal pools) — they are returned as
 * `prefixPad` so the caller can emit an explicit row and
 * Σsizes + prefixPad == group.size holds on every branch.
 */
export interface Allocation {
    sizes: number[];
    prefixPad: number;
}

export function allocateSizes(group: Contribution, warnings: Warnings): Allocation {
    const syms = group.symbols;
    const n = syms.length;
    if (n === 0) {
        return { sizes: [], prefixPad: 0 };
    }
    if (n === 1) {
        // A single symbol does not necessarily start at the contribution
        // start (LTO merged headers, literal pools). Handing it the whole
        // size used to push its interval past the contribution end with the
        // Σ==size check trivially true — clamp to the tail and model the
        // unclaimed prefix instead.
        const sym = syms[0];
        if (sym.addr < group.vma || sym.addr >= group.vma + group.size) {
            warnings.add('symbol address outside its contribution; size clamped', `${sym.name} @ 0x${sym.addr.toString(16)}`);
        }
        const prefixPad = Math.max(0, Math.min(group.size, sym.addr - group.vma));
        const size = Math.max(0, group.vma + group.size - sym.addr);
        return { sizes: [Math.min(size, group.size)], prefixPad };
    }
    const order = syms.map((_, i) => i).sort((a, b) => syms[a].addr - syms[b].addr);
    // Same clamp as the single-symbol branch: a first symbol beyond the
    // contribution end must not push the *unsym* row past it either
    // (review N3, REVIEW-dc30888). The data is contradictory anyway and the
    // sum check below still fires.
    const prefixPad = Math.min(group.size, Math.max(0, syms[order[0]].addr - group.vma));
    const sortedSizes: number[] = [];
    for (let k = 0; k < n - 1; k++) {
        const delta = syms[order[k + 1]].addr - syms[order[k]].addr;
        if (delta < 0 || delta > group.size) {
            warnings.add('symbol address outside its contribution; size clamped', `${syms[order[k]].name} @ 0x${syms[order[k]].addr.toString(16)}`);
        }
        sortedSizes.push(Math.max(0, Math.min(delta, group.size)));
    }
    const tail = group.vma + group.size - syms[order[n - 1]].addr;
    sortedSizes.push(Math.max(0, tail));

    const result = new Array<number>(n);
    order.forEach((origIdx, k) => {
        result[origIdx] = sortedSizes[k];
    });

    const sum = result.reduce((a, b) => a + b, 0);
    if (sum + prefixPad !== group.size) {
        warnings.add('symbol sizes do not sum to contribution size (padding or annotation drift)', `${group.section}: ${sum} vs ${group.size}`);
    }
    return { sizes: result, prefixPad };
}

function baseRecord(): Omit<SymbolRecord, 'name' | 'addr' | 'size' | 'kind' | 'section' | 'object' | 'status' | 'fromSectionName'> {
    return {
        mangled: null,
        demangled: null,
        archive: null,
        member: null,
        lma: null,
        storage: [],
        isFill: false,
        isSystem: false,
        isLto: false,
        outSection: null,
    };
}

export function parseGnuLd(text: string, warnings: Warnings): { regions: MemoryRegion[]; symbols: SymbolRecord[] } {
    const lines = text.split('\n');
    let state = State.Seek;

    const regions: MemoryRegion[] = [];
    const symbols: SymbolRecord[] = [];
    const looseFills: FillEntry[] = [];
    let currentLma: number | null = null;
    let currentSectionHeader = '';
    /** 1-based raw map line of the current output-section header (the line that prints its name). */
    let outputHeaderLine = 0;
    let pendingSection: string | null = null;
    /**
     * 1-based raw map line of `pendingSection` (the bare child-section header
     * `.text.foo` on a line of its own). Name and line only mean anything
     * together — the pair moves through this one setter so a stale line can
     * never outlive its name.
     */
    let pendingSectionLine: number | null = null;
    const setPendingSection = (name: string | null, line: number | null = null): void => {
        pendingSection = name;
        pendingSectionLine = line;
    };
    let group: Contribution | null = null;
    let discardedPendingName: string | null = null;
    let discardedPendingLine: number | null = null;
    let outSec: OutSection | null = null;
    // Output sections whose tiling search failed fall back to keep-all — the
    // pre-tiling double-count behavior. Surfaced once at the end so the
    // regression is observable without flooding per-section; meta sections
    // (non-alloc) are exempt, see resolveOutSec.
    let tilingFallbacks = 0;
    let budgetFailures = 0;
    // Output sections whose extent never became known (bare header, missing
    // extent line) — keep-all without ever running the search.
    let extentFallbacks = 0;

    const emitGroup = (g: Contribution, outSection: string | null): void => {
        const { sizes, prefixPad } = allocateSizes(g, warnings);
        const kind = classifySection(g.section);
        const { archive, member } = parseObjectField(cleanObjectField(g.object));
        g.symbols.forEach((sym, i) => {
            symbols.push({
                ...baseRecord(),
                name: sym.name,
                addr: sym.addr,
                size: sizes[i] ?? 0,
                kind,
                section: g.section,
                outSection,
                object: g.object,
                archive,
                member,
                lma: g.lma,
                status: 'kept',
                fromSectionName: false,
                line: sym.line,
            });
        });
        // Unclaimed bytes between the contribution start and its first symbol
        // (compiler glue, literal pools — ld prints no symbol for them).
        // Emitted with the contribution's own kind so storage accounting
        // matches the section's semantics (e.g. .data prefixes occupy the
        // flash load image too); a plain pad row would drop that.
        if (prefixPad > 0) {
            symbols.push({
                ...baseRecord(),
                name: '*unsym*',
                addr: g.vma,
                size: prefixPad,
                kind,
                section: g.section,
                outSection,
                object: g.object,
                archive,
                member,
                lma: g.lma,
                status: 'kept',
                fromSectionName: false,
            });
        }
        // Contribution without any symbol line (`.comment`, `.eh_frame`, debug
        // sections, ...): keep it as one section-level row so totals stay exact.
        if (g.symbols.length === 0 && g.size > 0) {
            const objClean = cleanObjectField(g.object);
            const { archive: a2, member: m2 } = parseObjectField(objClean);
            symbols.push({
                ...baseRecord(),
                name: g.section,
                addr: g.vma,
                size: g.size,
                kind,
                section: g.section,
                outSection,
                object: objClean,
                archive: a2,
                member: m2,
                lma: g.lma,
                status: 'kept',
                fromSectionName: true,
                line: g.sectionLine,
            });
        }
    };

    const emitFill = (f: FillEntry, outSection: string | null): void => {
        symbols.push({
            ...baseRecord(),
            name: '*fill*',
            addr: f.vma,
            size: f.size,
            kind: 'pad',
            section: f.section,
            outSection,
            object: '[pad]',
            lma: f.lma,
            status: 'kept',
            isFill: true,
            fromSectionName: false,
            line: f.line,
        });
    };

    const closeGroup = (): void => {
        if (!group) {
            return;
        }
        const g = group;
        group = null;
        if (outSec) {
            outSec.units.push({ kind: 'group', group: g });
        } else {
            emitGroup(g, null);
        }
    };

    /**
     * Resolve one buffered output section: keep the units that tile
     * [vma, vma+size) exactly (contribution + fill chain), drop the stale
     * merge/relax snapshots ld re-prints among them. When no exact tiling
     * exists (unusual layouts) fall back to keeping every unit.
     */
    const resolveOutSec = (sec: OutSection): void => {
        // Non-alloc sections have no address-space semantics: ld prints a VMA
        // per contribution that is really a file offset accumulation (every
        // object's `.ARM.attributes` block), so contributions can never tile
        // the header extent and the search would always fail. keep-all is the
        // correct behavior for them — and saves a pointless search.
        if (classifySection(sec.name) === 'meta') {
            for (const u of sec.units) {
                if (u.kind === 'group') {
                    emitGroup(u.group, sec.name);
                } else {
                    emitFill(u.fill, sec.name);
                }
            }
            return;
        }
        if (sec.vma == null || sec.size == null) {
            // Extent unknown — the tiling chain has nothing to compare
            // against, so keep-all is the only option. Say so anyway: stale
            // duplicate rows at the same address would otherwise count
            // silently (review N2, REVIEW-dc30888).
            if (sec.units.length > 0) {
                extentFallbacks++;
            }
            for (const u of sec.units) {
                if (u.kind === 'group') {
                    emitGroup(u.group, sec.name);
                } else {
                    emitFill(u.fill, sec.name);
                }
            }
            return;
        }
        if (sec.size === 0) {
            // Empty section — nothing to tile, nothing to warn about.
            for (const u of sec.units) {
                if (u.kind === 'group') {
                    emitGroup(u.group, sec.name);
                } else {
                    emitFill(u.fill, sec.name);
                }
            }
            return;
        }
        const start = sec.vma;
        const end = start + sec.size;
        const viable = sec.units
            .map((u, idx) => ({ u, idx }))
            .filter(({ u }) => {
                const v = unitVma(u);
                const s = unitSize(u);
                return v >= start && v + s <= end;
            })
            .sort(
                (a, b) =>
                    unitVma(a.u) - unitVma(b.u) ||
                    Number(bearingSymbols(b.u)) - Number(bearingSymbols(a.u)) ||
                    a.idx - b.idx,
            );
        const budget = { visits: 20000 };
        let budgetExhausted = false;
        const search = (cursor: number, from: number, acc: OutUnit[]): OutUnit[] | null => {
            if (cursor === end) {
                return acc;
            }
            if (budget.visits-- <= 0) {
                budgetExhausted = true;
                return null;
            }
            for (let i = from; i < viable.length; i++) {
                const v = unitVma(viable[i].u);
                if (v < cursor) {
                    continue;
                }
                if (v > cursor) {
                    return null; // vma-ordered: nothing can fill the gap
                }
                const found = search(cursor + unitSize(viable[i].u), i + 1, [...acc, viable[i].u]);
                if (found) {
                    return found;
                }
            }
            return null;
        };
        const chain = search(start, 0, []);
        if (!chain) {
            tilingFallbacks++;
            if (budgetExhausted) {
                budgetFailures++;
            }
        }
        for (const u of chain ?? sec.units) {
            if (u.kind === 'group') {
                emitGroup(u.group, sec.name);
            } else {
                emitFill(u.fill, sec.name);
            }
        }
    };

    const closeOutSec = (): void => {
        closeGroup();
        if (!outSec) {
            return;
        }
        const sec = outSec;
        outSec = null;
        resolveOutSec(sec);
    };

    const pushSectionRow = (section: string, vma: number, size: number, objectRaw: string, lma: number | null, status: 'kept' | 'discarded', line: number): void => {
        const obj = cleanObjectField(objectRaw);
        const { archive, member } = parseObjectField(obj);
        symbols.push({
            ...baseRecord(),
            name: section,
            addr: vma,
            size,
            kind: classifySection(section),
            section,
            // discarded 列表在 memory map 之外，没有输出段上下文
            outSection: null,
            object: obj,
            archive,
            member,
            lma,
            status,
            fromSectionName: true,
            line,
        });
    };

    for (const [lineNo, rawLine] of lines.entries()) {
        const line = rawLine.replace(/\r$/, '');
        if (line.length === 0) {
            continue;
        }
        const col0 = line[0] !== ' ' && line[0] !== '\t';
        const trimmed = line.trim();

        switch (state) {
            case State.Seek: {
                if (trimmed === 'Discarded input sections') {
                    state = State.Discarded;
                } else if (trimmed === 'Memory Configuration') {
                    state = State.MemoryConfig;
                } else if (trimmed === 'Linker script and memory map') {
                    state = State.MainMap;
                }
                break;
            }

            case State.Discarded: {
                if (col0 && (trimmed === 'Memory Configuration' || trimmed === 'Linker script and memory map')) {
                    state = trimmed === 'Memory Configuration' ? State.MemoryConfig : State.MainMap;
                    break;
                }
                if (col0 && OUTPUT_SECTION_RE.test(trimmed)) {
                    // Missing "Memory Configuration" anchor — a section header
                    // means we are past the discarded block.
                    state = State.MainMap;
                    break;
                }
                const one = DISCARDED_ONE_LINE_RE.exec(line);
                if (one && !HEX_ONLY_RE.test(one[1])) {
                    pushSectionRow(one[1], parseInt(one[2], 16), parseInt(one[3], 16), one[4], null, 'discarded', lineNo + 1);
                    discardedPendingName = null;
                    discardedPendingLine = null;
                    break;
                }
                const name = DISCARDED_NAME_RE.exec(line);
                if (name) {
                    // two-line form: anchor the row at the name line — that is
                    // where a reader looks for the symbol
                    discardedPendingName = name[1];
                    discardedPendingLine = lineNo + 1;
                    break;
                }
                const cont = DISCARDED_CONT_RE.exec(line);
                if (cont && discardedPendingName) {
                    pushSectionRow(discardedPendingName, parseInt(cont[1], 16), parseInt(cont[2], 16), cont[3], null, 'discarded', discardedPendingLine ?? lineNo + 1);
                    discardedPendingName = null;
                    discardedPendingLine = null;
                }
                break;
            }

            case State.MemoryConfig: {
                if (trimmed === 'Linker script and memory map') {
                    state = State.MainMap;
                    break;
                }
                if (col0 && !trimmed.startsWith('Name ')) {
                    const m = REGION_RE.exec(trimmed);
                    if (m && !m[1].startsWith('*') && m[1] !== 'Name') {
                        regions.push({
                            name: m[1],
                            origin: parseInt(m[2], 16),
                            length: parseInt(m[3], 16),
                            attrs: m[4] ?? '',
                            role: 'other',
                        });
                    }
                }
                break;
            }

            case State.MainMap: {
                if (col0) {
                    const header = OUTPUT_SECTION_RE.exec(trimmed);
                    if (header) {
                        closeOutSec();
                        outSec = { name: header[1], vma: parseInt(header[2], 16), size: parseInt(header[3], 16), units: [] };
                        currentSectionHeader = header[1];
                        outputHeaderLine = lineNo + 1;
                        currentLma = header[4] ? parseInt(header[4], 16) : null;
                        setPendingSection(null);
                        break;
                    }
                    if (trimmed === '/DISCARD/') {
                        closeOutSec();
                        outSec = { name: '/DISCARD/', vma: null, size: null, units: [] };
                        currentSectionHeader = '/DISCARD/';
                        outputHeaderLine = lineNo + 1;
                        setPendingSection(null);
                        break;
                    }
                    if (trimmed.startsWith('LOAD ') || trimmed.startsWith('OUTPUT(')) {
                        closeOutSec();
                        break;
                    }
                    if (trimmed.includes(' = ')) {
                        // linker-script assignment at column 0 ends the current group
                        closeGroup();
                        setPendingSection(null);
                        break;
                    }
                    const bareName = /^([A-Za-z_.][^\s]*)\s*$/.exec(trimmed);
                    if (bareName) {
                        // two-line output header: name alone, extent follows on
                        // the next line as a `load address` or bare `vma size`
                        // continuation
                        closeOutSec();
                        outSec = { name: bareName[1], vma: null, size: null, units: [] };
                        currentSectionHeader = bareName[1];
                        outputHeaderLine = lineNo + 1;
                        currentLma = null;
                        setPendingSection(null);
                        break;
                    }
                    break;
                }

                if (trimmed.length === 0) {
                    break;
                }

                const fill = FILL_RE.exec(line);
                if (fill) {
                    closeGroup();
                    setPendingSection(null);
                    // ld echoes a load address even for zero-init (.bss-style)
                    // sections — their fills never reach the load image
                    const zeroInit = classifySection(currentSectionHeader) === 'bss';
                    const entry = {
                        vma: parseInt(fill[1], 16),
                        size: parseInt(fill[2], 16),
                        section: currentSectionHeader,
                        lma: zeroInit ? null : currentLma,
                        line: lineNo + 1,
                    };
                    if (outSec) {
                        outSec.units.push({ kind: 'fill', fill: entry });
                    } else {
                        looseFills.push(entry);
                    }
                    break;
                }
                if (trimmed.startsWith('FILL ')) {
                    // `FILL mask 0xff` — script fill-pattern echo, no extent
                    break;
                }
                if (trimmed.startsWith('*') || (WILDCARD_ECHO_RE.test(trimmed) && !/0x/i.test(trimmed))) {
                    // wildcard / object-list echo (`*(.text*)`, `*crtbegin.o(.ctors)`,
                    // `libc.a(*)`) — informational only
                    break;
                }
                if (trimmed.startsWith('[!provide]')) {
                    closeGroup();
                    setPendingSection(null);
                    break;
                }

                const contrib = CONTRIBUTION_RE.exec(line);
                if (contrib) {
                    closeGroup();
                    setPendingSection(null);
                    group = {
                        section: contrib[1],
                        vma: parseInt(contrib[2], 16),
                        size: parseInt(contrib[3], 16),
                        lma: currentLma,
                        object: contrib[4],
                        // name and extent share this line, so it is its own
                        // locate target for the section-level row
                        sectionLine: lineNo + 1,
                        symbols: [],
                    };
                    break;
                }

                const sectionName = SECTION_NAME_RE.exec(line);
                if (sectionName) {
                    closeGroup();
                    setPendingSection(sectionName[1], lineNo + 1);
                    break;
                }

                const continuation = CONTINUATION_RE.exec(line);
                if (continuation) {
                    closeGroup();
                    const obj = continuation[3];
                    if (obj.startsWith('load address')) {
                        // second line of a two-line output header — carries the
                        // section extent, no contribution of its own. Zero-init
                        // script sections (`._user_heap_stack`) echo a load
                        // address that is not part of the flash image, so it
                        // stays unset for them; initialized data sections
                        // (Zephyr's `log_msg_ptr_area`, ...) print the same
                        // form with a real one.
                        if (outSec && outSec.vma == null) {
                            outSec.vma = parseInt(continuation[1], 16);
                            outSec.size = parseInt(continuation[2], 16);
                            if (classifySection(currentSectionHeader) !== 'bss') {
                                const lma = /load address\s+0x([0-9a-fA-F]+)/.exec(obj);
                                if (lma) {
                                    currentLma = parseInt(lma[1], 16);
                                }
                            }
                        }
                        setPendingSection(null);
                        break;
                    }
                    const section = pendingSection ?? (currentSectionHeader || '(unknown)');
                    if (!pendingSection && !currentSectionHeader) {
                        warnings.add('contribution line without a preceding section name', line.trim(), lineNo + 1);
                    }
                    // Section-level rows are located by name, so they must point
                    // at a line that prints it: the bare child header when ld
                    // printed one, else the output-section header. Only the
                    // extent line is left without a name (GNU ld prints no
                    // symbol line for local symbols — one per `static` function
                    // under -ffunction-sections).
                    const sectionLine = (pendingSection ? pendingSectionLine : outputHeaderLine) || lineNo + 1;
                    setPendingSection(null);
                    group = {
                        section,
                        vma: parseInt(continuation[1], 16),
                        size: parseInt(continuation[2], 16),
                        lma: currentLma,
                        object: obj,
                        sectionLine,
                        symbols: [],
                    };
                    break;
                }

                // Second line of a two-line output header in its bare-extent
                // form: `<vma> <size>` with no `load address` (`._user_heap_stack`
                // prints this shape; `.tm_clone_table` prints the load-address
                // form handled above). Without capturing it the section extent
                // stays unknown and tiling silently falls back to keep-all.
                if (outSec && outSec.vma == null && outSec.name !== '/DISCARD/') {
                    const bareExtent = /^\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s*$/.exec(line);
                    if (bareExtent) {
                        outSec.vma = parseInt(bareExtent[1], 16);
                        outSec.size = parseInt(bareExtent[2], 16);
                        setPendingSection(null);
                        break;
                    }
                }

                const symbol = SYMBOL_RE.exec(line);
                if (symbol) {
                    const name = symbol[2];
                    // binutils relax annotations: `0x10 (size before relaxing)` — no address
                    if (name.startsWith('(size before') || name.startsWith('(before ')) {
                        break;
                    }
                    // linker-script assertions echo an address before the expression
                    if (name.startsWith('ASSERT ') || name.startsWith('ASSERT(')) {
                        break;
                    }
                    // linker-script assignments echo an address before the expression
                    if (name.includes(' = ')) {
                        closeGroup();
                        setPendingSection(null);
                        break;
                    }
                    if (HEX_ONLY_RE.test(name)) {
                        closeGroup();
                        break;
                    }
                    if (group) {
                        group.symbols.push({ addr: parseInt(symbol[1], 16), name, line: lineNo + 1 });
                    } else {
                        warnings.add('symbol line without a preceding contribution', line.trim(), lineNo + 1);
                    }
                    break;
                }

                warnings.add('unrecognized line', line.trim(), lineNo + 1);
                break;
            }
        }
    }
    closeOutSec();

    // Fill entries seen outside any output section become pad rows attributed
    // to their surrounding output section header. `outSection` stays null —
    // they were not part of a resolved output section, and the header name in
    // `section` may even be stale after a LOAD/OUTPUT boundary, so the
    // attribution is ambiguous enough to warn about.
    for (const fill of looseFills) {
        warnings.add(
            fill.section
                ? `fill outside any output section — attributed to possibly stale header "${fill.section}"`
                : 'fill outside any output section (no section header seen)',
            `*fill* 0x${fill.vma.toString(16)}`,
        );
        emitFill(fill, null);
    }

    if (tilingFallbacks > 0) {
        let msg = `tiling search failed in ${tilingFallbacks} output section(s) — kept all candidate lines (possible double count)`;
        if (budgetFailures > 0) {
            msg += `; visit budget exhausted in ${budgetFailures} of them`;
        }
        warnings.add(msg);
    }
    if (extentFallbacks > 0) {
        warnings.add(
            `output extent unknown for ${extentFallbacks} output section(s) — kept all candidate lines without tiling (possible double count)`,
        );
    }

    // Rows whose name came from a section often embed the mangled symbol
    // (`.text._ZN3app4mainEv`) — keep it for demangling and copy actions.
    for (const sym of symbols) {
        if (sym.fromSectionName) {
            sym.mangled = extractSectionSymbol(sym.section);
        }
    }

    return { regions, symbols };
}
