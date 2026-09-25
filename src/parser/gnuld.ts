import type { MemoryRegion, SymbolRecord } from '../types';
import { classifySection } from './classify';
import { extractSectionSymbol } from '../demangle';
import type { Warnings } from './warnings';

/**
 * Parser for GNU ld "Linker script and memory map" output
 * (gcc / arm-none-eabi-gcc `-Wl,-Map=...`).
 * Line grammar and size-allocation algorithm: docs/FORMATS.md §1.
 */

const OUTPUT_SECTION_RE =
    /^(\.[^\s]+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)(?:\s+load address\s+0x([0-9a-fA-F]+))?(?:\s*\(size before (?:relaxing|filtering) 0x[0-9a-fA-F]+\))?(?:\s+[a-zA-Z].*)?\s*$/;
const CONTRIBUTION_RE = /^\s+(\.[^\s]+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(.+?)\s*$/;
const CONTINUATION_RE = /^\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(.+?)\s*$/;
const SECTION_NAME_RE = /^\s+(\.[^\s]+)\s*$/;
const SYMBOL_RE = /^\s+0x([0-9a-fA-F]+)\s+(.+?)\s*$/;
const FILL_RE = /^\s+\*fill\*\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)/;
const DISCARDED_ONE_LINE_RE = /^\s+([^\s]+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(\S+)\s*$/;
const DISCARDED_NAME_RE = /^\s+([^\s0][^\s]*)\s*$/;
const DISCARDED_CONT_RE = /^\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(\S+)\s*$/;
const REGION_RE = /^(\S+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)(?:\s+(\S+))?\s*$/;
const ARCHIVE_MEMBER_RE = /^(.*\.a)\((.+)\)$/;
const HEX_ONLY_RE = /^0x[0-9a-fA-F]+$/;

interface PendingSymbol {
    addr: number;
    name: string;
}

interface Contribution {
    section: string;
    vma: number;
    size: number;
    lma: number | null;
    object: string;
    symbols: PendingSymbol[];
}

interface FillEntry {
    vma: number;
    size: number;
    section: string;
}

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
 * Returns sizes in the same order as group.symbols.
 */
export function allocateSizes(group: Contribution, warnings: Warnings): number[] {
    const syms = group.symbols;
    const n = syms.length;
    if (n === 0) {
        return [];
    }
    if (n === 1) {
        return [group.size];
    }
    const order = syms.map((_, i) => i).sort((a, b) => syms[a].addr - syms[b].addr);
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
    if (sum !== group.size) {
        warnings.add('symbol sizes do not sum to contribution size (padding or annotation drift)', `${group.section}: ${sum} vs ${group.size}`);
    }
    return result;
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
    };
}

export function parseGnuLd(text: string, warnings: Warnings): { regions: MemoryRegion[]; symbols: SymbolRecord[] } {
    const lines = text.split('\n');
    let state = State.Seek;

    const regions: MemoryRegion[] = [];
    const symbols: SymbolRecord[] = [];
    const fills: FillEntry[] = [];

    let currentLma: number | null = null;
    let currentSectionHeader = '';
    let pendingSection: string | null = null;
    let group: Contribution | null = null;
    let discardedPendingName: string | null = null;

    const flushGroup = (): void => {
        if (!group) {
            return;
        }
        const g = group;
        group = null;
        const sizes = allocateSizes(g, warnings);
        const { archive, member } = parseObjectField(cleanObjectField(g.object));
        g.symbols.forEach((sym, i) => {
            symbols.push({
                ...baseRecord(),
                name: sym.name,
                addr: sym.addr,
                size: sizes[i] ?? 0,
                kind: classifySection(g.section),
                section: g.section,
                object: g.object,
                archive,
                member,
                lma: g.lma,
                status: 'kept',
                fromSectionName: false,
            });
        });
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
                kind: classifySection(g.section),
                section: g.section,
                object: objClean,
                archive: a2,
                member: m2,
                lma: g.lma,
                status: 'kept',
                fromSectionName: true,
            });
        }
    };

    const pushSectionRow = (section: string, vma: number, size: number, objectRaw: string, lma: number | null, status: 'kept' | 'discarded'): void => {
        const obj = cleanObjectField(objectRaw);
        const { archive, member } = parseObjectField(obj);
        symbols.push({
            ...baseRecord(),
            name: section,
            addr: vma,
            size,
            kind: classifySection(section),
            section,
            object: obj,
            archive,
            member,
            lma,
            status,
            fromSectionName: true,
        });
    };

    for (const rawLine of lines) {
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
                    pushSectionRow(one[1], parseInt(one[2], 16), parseInt(one[3], 16), one[4], null, 'discarded');
                    discardedPendingName = null;
                    break;
                }
                const name = DISCARDED_NAME_RE.exec(line);
                if (name) {
                    discardedPendingName = name[1];
                    break;
                }
                const cont = DISCARDED_CONT_RE.exec(line);
                if (cont && discardedPendingName) {
                    pushSectionRow(discardedPendingName, parseInt(cont[1], 16), parseInt(cont[2], 16), cont[3], null, 'discarded');
                    discardedPendingName = null;
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
                        flushGroup();
                        pendingSection = null;
                        currentSectionHeader = header[1];
                        currentLma = header[4] ? parseInt(header[4], 16) : null;
                        break;
                    }
                    if (trimmed.startsWith('LOAD ') || trimmed.startsWith('OUTPUT(')) {
                        break;
                    }
                    if (trimmed.includes(' = ')) {
                        // linker-script assignment at column 0 ends the current group
                        flushGroup();
                        pendingSection = null;
                        break;
                    }
                    break;
                }

                if (trimmed.length === 0) {
                    break;
                }

                const fill = FILL_RE.exec(line);
                if (fill) {
                    flushGroup();
                    pendingSection = null;
                    fills.push({ vma: parseInt(fill[1], 16), size: parseInt(fill[2], 16), section: currentSectionHeader });
                    break;
                }
                if (trimmed.startsWith('*(')) {
                    // wildcard echo — informational only
                    break;
                }
                if (trimmed.startsWith('[!provide]')) {
                    flushGroup();
                    pendingSection = null;
                    break;
                }

                const contrib = CONTRIBUTION_RE.exec(line);
                if (contrib) {
                    flushGroup();
                    pendingSection = null;
                    group = {
                        section: contrib[1],
                        vma: parseInt(contrib[2], 16),
                        size: parseInt(contrib[3], 16),
                        lma: currentLma,
                        object: contrib[4],
                        symbols: [],
                    };
                    break;
                }

                const sectionName = SECTION_NAME_RE.exec(line);
                if (sectionName) {
                    flushGroup();
                    pendingSection = sectionName[1];
                    break;
                }

                const continuation = CONTINUATION_RE.exec(line);
                if (continuation) {
                    flushGroup();
                    const section = pendingSection ?? '(unknown)';
                    if (!pendingSection) {
                        warnings.add('contribution line without a preceding section name', line.trim());
                    }
                    pendingSection = null;
                    group = {
                        section,
                        vma: parseInt(continuation[1], 16),
                        size: parseInt(continuation[2], 16),
                        lma: currentLma,
                        object: continuation[3],
                        symbols: [],
                    };
                    break;
                }

                const symbol = SYMBOL_RE.exec(line);
                if (symbol) {
                    const name = symbol[2];
                    // binutils relax annotations: `0x10 (size before relaxing)` — no address
                    if (name.startsWith('(size before') || name.startsWith('(before ')) {
                        break;
                    }
                    // linker-script assignments echo an address before the expression
                    if (name.includes(' = ')) {
                        flushGroup();
                        pendingSection = null;
                        break;
                    }
                    if (HEX_ONLY_RE.test(name)) {
                        flushGroup();
                        break;
                    }
                    if (group) {
                        group.symbols.push({ addr: parseInt(symbol[1], 16), name });
                    } else {
                        warnings.add('symbol line without a preceding contribution', line.trim());
                    }
                    break;
                }

                warnings.add('unrecognized line', line.trim());
                break;
            }
        }
    }
    flushGroup();

    // Fill entries become pad rows attributed to their surrounding output section.
    for (const fill of fills) {
        symbols.push({
            ...baseRecord(),
            name: '*fill*',
            addr: fill.vma,
            size: fill.size,
            kind: 'pad',
            section: fill.section,
            object: '[pad]',
            lma: null,
            status: 'kept',
            isFill: true,
            fromSectionName: false,
        });
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
