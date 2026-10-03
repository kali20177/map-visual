import type { SymbolRecord, SymbolKind } from '../types';
import { classifySection } from './classify';
import { extractSectionSymbol } from '../demangle';
import { parseObjectField } from './gnuld';
import type { Warnings } from './warnings';

/**
 * Parser for LLVM lld's tabular map format (`ld.lld -Map=...`):
 *
 *     VMA      LMA     Size Align Out     In      Symbol
 *   000100d4 000100d4        4     4 .interp
 *   000100d4 000100d4       13     1         <internal>:(.interp)
 *   000101c4 000101c4       1c     4         main.cpp.o:(.text.main)
 *   000101c4 000101c4       1c     4                 main
 *
 * Addresses and sizes are hex without the 0x prefix. Output-section rows have
 * no indentation before the name; input rows carry `file:(section)`, `file:(COMMON)`
 * or `archive.a(member.o):(section)`, symbol rows carry a bare name. lld
 * reports real per-symbol sizes, but ELF symtab aliases are sized to their
 * whole cluster — symbol rows still get delta-style clamping (see flush).
 *
 * Symbol names are demangled by default (lld demangles map symbol rows;
 * `--no-demangle` keeps them mangled — the pipeline's isMangled fallback
 * demangles those). Mangled names always survive in -ffunction-sections
 * section names (`.text._ZN...`), where the pipeline recovers them.
 *
 * Real-corpus shapes (stm32f103-rb-demo clang+lld, lld 23.1.2):
 * - linker-script statements print as rows at ANY indent (`_estack = ...`,
 *   `. = ALIGN(4)`, `. = . + 0x200`, `LONG(0x...)`, `PROVIDE(x = y)`) —
 *   grammar, not symbols or sections; skipped
 * - input rows are not address-ordered: lld's merged `.eh_frame` contribution
 *   is appended after the real inputs with a stale, overlapping address and a
 *   `+0x0` section-name suffix (verified against nm on the ELF). Such merged
 *   rows are skipped; their bytes are accounted by the section's fills or
 *   extent row instead
 * - holes are computed from the SORTED input spans up to the printed
 *   output-section extent, trailing bytes included, and synthesized as
 *   `*fill*` rows (no raw line, same policy as `*unsym*`) so row sums
 *   reconcile with the ELF byte-exactly
 * - a section with no input rows at all is script-grown (`.= .+ N`, `LONG()`
 *   content — `._user_heap_stack`, `.fw_signature`): the out row is the only
 *   extent truth and is kept as one section-level row
 * - weak-alias clusters (startup IRQ handlers) print N symbol rows over the
 *   same bytes, and ELF-sized aliases overlap across addresses (libgcc
 *   clusters) — sizes collapse per address and clamp to the next occupier /
 *   contribution end; bytes no symbol claims (size-0 assembler labels over
 *   vector tables) come back as `*unsym*` rows
 *
 * ARM/Thumb: lld prints code-symbol addresses with the Thumb state bit set
 * (`main` at 0x100ad for section address 0x100ac) — one past the byte address
 * the ELF symbol table and GNU ld's map carry. For ARM maps (identified by
 * `.ARM.*` sections or `$t`/`$a` mapping symbols) bit0 is stripped from odd
 * addresses inside code sections so per-symbol spans tile the section;
 * genuine odd data addresses are untouched.
 */

// Columns are hex; group 5 captures the (mandatory) separator whitespace and
// group 6 the description. The whole table may carry leading indentation
// (real maps start VMA at column 3). Children rows are separated from the
// Align column by ≥2 spaces, output sections by exactly 1 — that gap is the
// row-type discriminator.
const ROW_RE = /^\s*([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)(\s\s*)(.*)$/;
// The `:` before `(section)` must not itself be part of `::` — demangled
// C++ symbol rows like `ui::game::(anonymous namespace)::hurt(...)`
// otherwise parse as input rows (`::(` splits at the first colon) and
// phantom contributions double-count their bytes (rb-demo clang+lld).
const INPUT_ROW_RE = /^(.+):(?<!::)(\(.+\)|COMMON)$/;
// linker-script statement rows: assignments (`_estack = ...`, `. = ALIGN(4)`,
// `. = . + 0x200`), compound assignments (`. += 0x0 - (. - x)`, Zephyr's
// generated scripts print them inside rom_start), script content words
// (`LONG(0x...)`) and PROVIDE forms. Demangled symbol names never carry
// spaced assignment operators (operators demangle to `operator+=` without
// spaces), so the assignment test is safe.
const SCRIPT_ROW_RE =
    /\s(?:<<=|>>=|[+\-*/&|^]?=)\s|^(?:LONG|SHORT|WORD|BYTE|QUAD|SQUAD|ASCIZ|ASCII)\(|^PROVIDE/i;
// synthetic merged contributions (`.eh_frame+0x0`) — stale-addressed, skipped
const MERGED_SECTION_RE = /\+(?:0x)?[0-9a-fA-F]+$/;

interface Contribution {
    section: string;
    vma: number;
    lma: number;
    size: number;
    object: string;
    /** 1-based raw map line of the input-section row. */
    line: number;
    symbols: { name: string; addr: number; size: number; line: number; lma: number }[];
}

interface OutRow {
    name: string;
    vma: number;
    lma: number;
    size: number;
    /** 1-based raw map line of the output-section row. */
    line: number;
    /** VMA = LMA = 0: lld assigned no memory (non-alloc (COPY)-style tail). */
    unplaced: boolean;
}

function makeRecord(): Omit<SymbolRecord, 'name' | 'addr' | 'size' | 'kind' | 'section' | 'object' | 'status' | 'fromSectionName'> {
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

export function parseLld(text: string, warnings: Warnings): { regions: never[]; symbols: SymbolRecord[] } {
    const symbols: SymbolRecord[] = [];
    let current: Contribution | null = null;
    // the enclosing output section (Out column) — rows below carry it so
    // consumers can group at linker-script granularity instead of the input
    // section (`file:(.text.main)`)
    let outSection: string | null = null;
    // the enclosing output-section row (extent truth for fills / extent rows)
    let out: OutRow | null = null;
    // input spans seen inside `out`, in printed order — holes are computed
    // from the sorted spans because lld does not print input rows in address
    // order (merged .eh_frame contributions come last, stale-addressed)
    let pendingSpans: { vma: number; size: number }[] = [];
    // ARM/Thumb evidence: a `.ARM.*` output section or a `$t`/`$a` mapping
    // symbol — both always present in ARM compiler output that contains code
    let armTarget = false;

    // synthesized alignment padding: no raw map line exists to point at
    // (same policy as gnuld's `*unsym*` prefix pads), storage follows the
    // section class via analyze's fill reclassification
    const emitFill = (start: number, size: number): void => {
        if (!out || size <= 0) {
            return;
        }
        symbols.push({
            ...makeRecord(),
            name: '*fill*',
            addr: start,
            size,
            kind: 'pad',
            section: out.name,
            outSection: out.name,
            object: '[pad]',
            lma: out.lma,
            status: 'kept',
            isFill: true,
            fromSectionName: false,
        });
    };

    // Non-alloc (COPY)-style sections (`.log_strings`) print VMA = LMA = 0 —
    // lld assigns them no memory, but their input rows carry incrementing
    // file offsets, so the verdict is per-section, not per-row. Only custom
    // names classify as `other` (`.comment` and friends are already meta);
    // forcing those to meta keeps them out of flash/ram the way the gnuld
    // path's scratch-region downgrade does.
    const kindOf = (name: string): SymbolKind => {
        const k = classifySection(name);
        return out != null && out.unplaced && k === 'other' ? 'meta' : k;
    };

    // closing the output section: holes between the sorted input spans and
    // the trailing bytes up to the printed extent are alignment/synthetic
    // content lld never prints; a section without input rows is script-grown
    // and kept as one extent row (its bytes would otherwise vanish — lld
    // prints no fill entries and the script rows are not contributions)
    const closeOut = (): void => {
        if (out) {
            if (pendingSpans.length === 0) {
                if (out.size > 0) {
                    symbols.push({
                        ...makeRecord(),
                        name: out.name,
                        addr: out.vma,
                        size: out.size,
                        kind: kindOf(out.name),
                        section: out.name,
                        outSection: out.name,
                        object: '<internal>',
                        lma: out.lma,
                        status: 'kept',
                        fromSectionName: true,
                        line: out.line,
                    });
                }
            } else if (!out.unplaced) {
                // unplaced sections live in file-offset space, not memory —
                // their spans are emitted as meta rows and holes mean nothing
                const spans = [...pendingSpans].sort((a, b) => a.vma - b.vma);
                let cursor = out.vma;
                for (const s of spans) {
                    if (s.vma > cursor) {
                        emitFill(cursor, s.vma - cursor);
                    }
                    if (s.vma + s.size > cursor) {
                        cursor = s.vma + s.size;
                    }
                }
                const end = out.vma + out.size;
                if (end > cursor) {
                    emitFill(cursor, end - cursor);
                }
            }
        }
        out = null;
        pendingSpans = [];
    };

    const flush = (): void => {
        if (!current) {
            return;
        }
        const c = current;
        current = null;
        const { archive, member } = parseObjectField(c.object);
        const kind = kindOf(c.section);
        if (c.symbols.length === 0) {
            symbols.push({
                ...makeRecord(),
                name: c.section,
                addr: c.vma,
                size: c.size,
                kind,
                section: c.section,
                outSection,
                object: c.object,
                archive,
                member,
                lma: c.lma,
                status: 'kept',
                fromSectionName: true,
                line: c.line,
            });
            return;
        }
        // Symbol sizes need three adjustments to tile the contribution the
        // way GNU ld's delta allocation does for free:
        // 1. same-address collapse — weak-alias clusters (startup IRQ
        //    handlers) print N rows over the same bytes; the size stays on
        //    the group's first non-zero symbol, the rest collapse to zero
        //    ($t/$a anchors are zero-size and never occupy)
        // 2. clamp to the next occupier / contribution end — ELF symtab
        //    aliases are sized to their whole cluster (libgcc's
        //    __aeabi_frsub 0x1c8 overlaps __subsf3's 0x1c0), so raw sizes
        //    overlap whenever aliases live at different addresses
        // 3. *unsym* rows for bytes no symbol claims — assembler labels
        //    carry size 0 (vector tables, fault handlers), leaving the
        //    contribution's extent unclaimed
        const sorted = [...c.symbols].sort((a, b) => a.addr - b.addr);
        const zeroed = new Set<{ name: string }>();
        let runOccupied = false;
        let runAddr = NaN;
        for (const s of sorted) {
            if (s.addr !== runAddr) {
                runAddr = s.addr;
                runOccupied = false;
            }
            if (runOccupied) {
                zeroed.add(s);
            } else if (s.size > 0) {
                runOccupied = true;
            }
        }
        const occupiers = sorted.filter((s) => !zeroed.has(s) && s.size > 0);
        for (let i = 0; i < occupiers.length; i++) {
            const limit = i + 1 < occupiers.length ? occupiers[i + 1].addr : c.vma + c.size;
            occupiers[i].size = Math.max(0, Math.min(occupiers[i].size, limit - occupiers[i].addr));
        }
        const holes: { addr: number; size: number }[] = [];
        let cursor = c.vma;
        const end = c.vma + c.size;
        for (const s of occupiers) {
            if (s.addr > cursor) {
                holes.push({ addr: cursor, size: s.addr - cursor });
            }
            if (s.addr + s.size > cursor) {
                cursor = s.addr + s.size;
            }
        }
        if (cursor < end) {
            holes.push({ addr: cursor, size: end - cursor });
        }
        for (const sym of c.symbols) {
            symbols.push({
                ...makeRecord(),
                name: sym.name,
                addr: sym.addr,
                size: zeroed.has(sym) ? 0 : sym.size,
                kind,
                section: c.section,
                outSection,
                object: c.object,
                archive,
                member,
                lma: sym.lma,
                status: 'kept',
                fromSectionName: false,
                line: sym.line,
            });
        }
        for (const h of holes) {
            symbols.push({
                ...makeRecord(),
                name: '*unsym*',
                addr: h.addr,
                size: h.size,
                kind,
                section: c.section,
                outSection,
                object: c.object,
                archive,
                member,
                lma: c.lma,
                status: 'kept',
                fromSectionName: false,
            });
        }
    };

    for (const [lineNo, rawLine] of text.split('\n').entries()) {
        const line = rawLine.replace(/\r$/, '');
        if (line.length === 0) {
            continue;
        }
        const row = ROW_RE.exec(line);
        if (!row) {
            // header line and any annotations
            if (line.includes(':') && !line.includes('VMA')) {
                warnings.add('unrecognizedLine', { sample: line.trim(), line: lineNo + 1 });
            }
            continue;
        }
        const vma = parseInt(row[1], 16);
        const lma = parseInt(row[2], 16);
        const size = parseInt(row[3], 16);
        const indent = row[5];
        const desc = row[6];

        // linker-script statements at any indent (top-level ones carry the
        // 1-space indent of an out row!) — grammar, not content
        if (SCRIPT_ROW_RE.test(desc)) {
            continue;
        }

        if (indent.length < 2) {
            // output-section row: flushes the previous group, closes the
            // previous section (fills / extent row), starts a new one
            flush();
            closeOut();
            out = { name: desc.trim(), vma, lma, size, line: lineNo + 1, unplaced: vma === 0 && lma === 0 };
            pendingSpans = [];
            outSection = out.name || null;
            if (out.name.startsWith('.ARM')) {
                armTarget = true;
            }
            continue;
        }

        const content = desc.trim();
        const input = INPUT_ROW_RE.exec(content);
        if (input) {
            const section = input[2] === 'COMMON' ? 'COMMON' : input[2].slice(1, -1);
            // merged contributions (.eh_frame+0x0) print stale, overlapping
            // addresses — skipped; their bytes are covered by the section's
            // fills or extent row
            if (MERGED_SECTION_RE.test(section)) {
                continue;
            }
            flush();
            pendingSpans.push({ vma, size });
            current = {
                section,
                vma,
                lma,
                size,
                object: input[1],
                line: lineNo + 1,
                symbols: [],
            };
            continue;
        }

        // symbol row
        if (content === '$t' || content === '$a') {
            armTarget = true;
        }
        if (current) {
            // Thumb state bit: code symbols inside ARM maps print odd (one
            // past the byte address); data symbols keep their real address
            const addr =
                armTarget && (vma & 1) !== 0 && classifySection(current.section) === 'code' ? vma - 1 : vma;
            // symbol rows carry their own LMA — the contribution's LMA is the
            // section start, and per-symbol VMA==LMA equality is what tells
            // in-place content apart from copied data (storage semantics)
            current.symbols.push({ name: content, addr, size, line: lineNo + 1, lma });
        } else {
            warnings.add('symbolWithoutInputSection', { sample: line.trim(), line: lineNo + 1 });
        }
    }
    flush();
    closeOut();

    // Input rows without symbol children keep their own size in the
    // section-level row; lld never reports fills in the map — the parser
    // synthesizes them from sorted input spans and the printed extent
    // (see closeOut/emitFill).
    for (const sym of symbols) {
        if (sym.fromSectionName) {
            sym.mangled = extractSectionSymbol(sym.section);
        }
    }

    return { regions: [], symbols };
}
