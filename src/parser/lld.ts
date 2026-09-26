import type { SymbolRecord } from '../types';
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
 * no indentation before the name; input rows carry `file:(section)` (or
 * `file:(COMMON)`), symbol rows carry a bare name. Unlike GNU ld, lld reports
 * real per-symbol sizes — no delta allocation needed.
 */

// Columns are hex; group 5 captures the (mandatory) separator whitespace and
// group 6 the description. The whole table may carry leading indentation
// (real maps start VMA at column 3). Children rows are separated from the
// Align column by ≥2 spaces, output sections by exactly 1 — that gap is the
// row-type discriminator.
const ROW_RE = /^\s*([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)(\s\s*)(.*)$/;
const INPUT_ROW_RE = /^(.+):(\(.+\)|COMMON)$/;

interface Contribution {
    section: string;
    vma: number;
    lma: number;
    size: number;
    object: string;
    symbols: { name: string; addr: number; size: number }[];
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

    const flush = (): void => {
        if (!current) {
            return;
        }
        const c = current;
        current = null;
        const { archive, member } = parseObjectField(c.object);
        if (c.symbols.length === 0) {
            symbols.push({
                ...makeRecord(),
                name: c.section,
                addr: c.vma,
                size: c.size,
                kind: classifySection(c.section),
                section: c.section,
                outSection,
                object: c.object,
                archive,
                member,
                lma: c.lma,
                status: 'kept',
                fromSectionName: true,
            });
        }
        for (const sym of c.symbols) {
            symbols.push({
                ...makeRecord(),
                name: sym.name,
                addr: sym.addr,
                size: sym.size,
                kind: classifySection(c.section),
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
                warnings.add('unrecognized line', line.trim(), lineNo + 1);
            }
            continue;
        }
        const vma = parseInt(row[1], 16);
        const lma = parseInt(row[2], 16);
        const size = parseInt(row[3], 16);
        const indent = row[5];
        const desc = row[6];

        if (indent.length < 2) {
            // output-section row: flushes the previous group (which belonged
            // to the previous output section) and starts a new one
            flush();
            outSection = desc.trim() || null;
            continue;
        }

        const content = desc.trim();
        const input = INPUT_ROW_RE.exec(content);
        if (input) {
            flush();
            current = {
                section: input[2] === 'COMMON' ? 'COMMON' : input[2].slice(1, -1),
                vma,
                lma,
                size,
                object: input[1],
                symbols: [],
            };
            continue;
        }

        // symbol row
        if (current) {
            current.symbols.push({ name: content, addr: vma, size });
        } else {
            warnings.add('symbol row without a preceding input section', line.trim(), lineNo + 1);
        }
    }
    flush();

    // Input rows without symbol children keep their own size in the
    // section-level row; lld never reports fills in the map.
    for (const sym of symbols) {
        if (sym.fromSectionName) {
            sym.mangled = extractSectionSymbol(sym.section);
        }
    }

    return { regions: [], symbols };
}
