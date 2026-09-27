/**
 * MapVisual intermediate representation (IR).
 *
 * Parsers produce a MapDocument; the webview renders it. The symbol list is
 * flat (one row per symbol / fill / discarded entry) — contribution-level
 * information is preserved on the row itself (section, object, addresses),
 * so the webview never needs the original grouping.
 */

export type MapFormat = 'gnu-ld' | 'lld' | 'armlink' | 'ilink' | 'unknown';

export type SymbolKind = 'code' | 'rodata' | 'data' | 'bss' | 'meta' | 'pad' | 'other';

export type Storage = 'flash' | 'ram';

export interface MemoryRegion {
    name: string;
    origin: number;
    length: number;
    attrs: string;
    role: 'flash' | 'ram' | 'other';
}

export interface SymbolRecord {
    /** Display name as it appeared in the map (may already be demangled by the linker). */
    name: string;
    /** Mangled form when known (extracted from section names like `.text._ZN...`, or the raw symbol). */
    mangled: string | null;
    /** Demangled form (WASM demangler); null when not demanglable / demangling disabled. */
    demangled: string | null;
    addr: number;
    size: number;
    kind: SymbolKind;
    section: string;
    /**
     * Output section (linker-script level: `.text`, Zephyr's dot-less `text`,
     * ...) when the map identifies one — `section` is the input section
     * (`.text.foo`). GNU ld prints both granularities, so grouping by
     * `section` alone mixes them (a fill row's `section` is the output
     * header, a symbol row's is the input section); group by `outSection`
     * when a real output-section view is needed. Null outside any output
     * section (loose fills, discarded lists).
     */
    outSection: string | null;
    object: string;
    archive: string | null;
    member: string | null;
    /** Load address when the map provides one (.data → flash copy). Null otherwise. */
    lma: number | null;
    storage: Storage[];
    status: 'kept' | 'discarded';
    /** True for `*fill*` / PAD rows. */
    isFill: boolean;
    /** Name was reconstructed from a mangled section name (`.text._ZN...`) rather than a symbol line. */
    fromSectionName: boolean;
    /** Heuristically flagged as compiler/runtime object (crt*.o, libgcc, newlib, ...). */
    isSystem: boolean;
    /** Object file is an LTO intermediate (.ltrans*.o / LLVM fat LTO names). */
    isLto: boolean;
    /** 1-based line in the raw map file this row was parsed from; absent for synthesized rows (`*unsym*` prefix pads). */
    line?: number;
}

export interface ParseWarning {
    message: string;
    count: number;
    samples: string[];
    /** 1-based source line of the first occurrence, when the warning comes from a specific line. */
    line?: number;
}

export interface MapTotals {
    flash: number;
    ram: number;
    keptCount: number;
    discardedCount: number;
    fillTotal: number;
    kindTotals: Record<SymbolKind, number>;
    /** Per-region used size, derived from kept symbols + fills falling into the region. */
    regions: { region: MemoryRegion; used: number }[];
}

export interface MapDocument {
    format: MapFormat;
    file: string;
    regions: MemoryRegion[];
    symbols: SymbolRecord[];
    totals: MapTotals;
    warnings: ParseWarning[];
}

export const EMPTY_KIND_TOTALS = (): Record<SymbolKind, number> => ({
    code: 0,
    rodata: 0,
    data: 0,
    bss: 0,
    meta: 0,
    pad: 0,
    other: 0,
});

// ── Map Diff (M5) ──
// Shared diff contract: computed in the worker (analysis/diff.ts), consumed
// by host + diff webview. Kept here so the type import never crosses layer
// boundaries (dependency-cruiser: webview-allowlist / host-must-use-worker).

export type DiffStatus = 'added' | 'removed' | 'changed' | 'same';

export interface DiffRow {
    key: string;
    name: string;
    kind: SymbolKind;
    status: DiffStatus;
    sizeA: number;
    sizeB: number;
    delta: number;
    objectA: string | null;
    objectB: string | null;
}

export interface DiffResult {
    fileA: string;
    fileB: string;
    rows: DiffRow[];
    totalsA: MapTotals;
    totalsB: MapTotals;
}
