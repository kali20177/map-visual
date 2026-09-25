import type { MemoryRegion, SymbolRecord } from '../types';
import type { Warnings } from './warnings';
import { parseGnuLd } from './gnuld';
import { parseLld } from './lld';

/**
 * Format parser registry — the M2 (Keil armlink) / M4 (IAR ilink) plug-in point.
 *
 * Contract for a FormatParser implementation:
 *  - pure function over the map text; file IO stays in pipeline.ts
 *  - no 'vscode' / no extension-host imports (enforced: worker tree may not
 *    import vscode, see eslint.config.js no-restricted-imports)
 *  - unknown lines are recorded via Warnings, never thrown — map files come
 *    from many linker versions, robustness beats strictness
 *  - produces the unified IR of docs/FORMATS.md (regions with roles resolved
 *    later by analysis, flat SymbolRecord list, fill entries as pad rows,
 *    gc/removed sections as status:"discarded")
 *
 * To add a format (M2/M4): implement FormatParser, call registerParser, and
 * move the format out of the roadmap messages in pipeline.ts + detect.ts.
 */

export interface ParsedFormat {
    regions: MemoryRegion[];
    symbols: SymbolRecord[];
}

export interface FormatParser {
    parse(text: string, warnings: Warnings): ParsedFormat;
}

export type RegistryFormat = 'gnu-ld' | 'lld' | 'armlink' | 'ilink';

const registry = new Map<RegistryFormat, FormatParser>();

export function registerParser(format: RegistryFormat, parser: FormatParser): void {
    registry.set(format, parser);
}

export function getParser(format: string): FormatParser | undefined {
    return registry.get(format as RegistryFormat);
}

/** Formats with an interface slot reserved but no implementation yet (M2/M4). */
export const PLANNED_FORMATS: ReadonlyMap<string, string> = new Map([
    ['armlink', 'Keil armlink (AC5/AC6) parsing is planned for M2 — the map was detected correctly.'],
    ['ilink', 'IAR ilink parsing is planned for M4 (real-world .map samples needed) — the map was detected correctly.'],
]);

// M1 formats.
registerParser('gnu-ld', { parse: parseGnuLd });
registerParser('lld', { parse: parseLld });
