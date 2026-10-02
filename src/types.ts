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

/**
 * Stable identity of a parse anomaly.
 *
 * The parser is not allowed to know about the UI's language (and the CLI is a
 * script channel whose English output is a contract), so a warning carries both
 * the rendered English `message` and the pieces the UI needs to render it in
 * the user's language. `WARNING_TEMPLATES` is the single source both sides read,
 * which is what keeps a translated warning from drifting away from the English
 * one it is supposed to mirror.
 */
export type WarningCode =
    | 'unrecognizedLine'
    | 'symbolWithoutInputSection'
    | 'contributionWithoutSection'
    | 'symbolWithoutContribution'
    | 'symbolAddressClamped'
    | 'sizesDoNotSum'
    | 'fillOutsideOutputSectionStaleHeader'
    | 'fillOutsideOutputSection'
    | 'tilingSearchFailed'
    | 'tilingSearchFailedWithBudget'
    | 'outputExtentUnknown'
    | 'formatOverrideNoRows'
    | 'noRowsParsed'
    | 'demanglerUnavailable'
    | 'regionRoleSwappedRam'
    | 'regionRoleSwappedFlash';

/**
 * English wording of each warning, with `{0}`… placeholders for the values the
 * parser passes as `ParseWarning.params`. These exact strings are also the
 * translation keys, so editing one means updating the matching entry in
 * `l10n/bundle.l10n.*.json`.
 */
export const WARNING_TEMPLATES: Record<WarningCode, string> = {
    unrecognizedLine: 'unrecognized line',
    symbolWithoutInputSection: 'symbol row without a preceding input section',
    contributionWithoutSection: 'contribution line without a preceding section name',
    symbolWithoutContribution: 'symbol line without a preceding contribution',
    symbolAddressClamped: 'symbol address outside its contribution; size clamped',
    sizesDoNotSum: 'symbol sizes do not sum to contribution size (padding or annotation drift)',
    fillOutsideOutputSectionStaleHeader: 'fill outside any output section — attributed to possibly stale header "{0}"',
    fillOutsideOutputSection: 'fill outside any output section (no section header seen)',
    tilingSearchFailed: 'tiling search failed in {0} output section(s) — kept all candidate lines (possible double count)',
    tilingSearchFailedWithBudget:
        'tiling search failed in {0} output section(s) — kept all candidate lines (possible double count); visit budget exhausted in {1} of them',
    outputExtentUnknown: 'output extent unknown for {0} output section(s) — kept all candidate lines without tiling (possible double count)',
    formatOverrideNoRows: 'format override "{0}" yielded no rows — the map may not be in this format',
    noRowsParsed: 'no rows parsed — the map may be truncated or its memory map content is missing',
    demanglerUnavailable: 'demangler unavailable (WASM module failed to load) — mangled names kept as-is',
    regionRoleSwappedRam: 'region "{0}" holds executable content but its name suggests RAM — flash/ram roles may be swapped',
    regionRoleSwappedFlash: 'region "{0}" holds zero-init content but its name suggests flash — flash/ram roles may be swapped',
};

export interface ParseWarning {
    /** English wording, rendered from `WARNING_TEMPLATES[code]` — the CLI contract. */
    message: string;
    count: number;
    samples: string[];
    /** 1-based source line of the first occurrence, when the warning comes from a specific line. */
    line?: number;
    code: WarningCode;
    /** Values for the template's `{0}`… placeholders. */
    params?: Array<string | number>;
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

// ── View state (webview ⇄ host) ──
// The webview owns this schema (it is the only thing that interprets it) but
// the host stores and replays it, so the shape is a cross-layer contract and
// lives here rather than in webview/model.ts — dependency-cruiser forbids the
// host from reaching into src/webview/.
//
// Two layers of persistence, both driven by the same blob:
//   1. webview `setState`  — survives the webview being torn down and
//      re-created (switching tabs away and back);
//   2. host `workspaceState` — survives closing the file and restarting
//      VS Code, per map file.

/**
 * Single source of truth for the view dimensions: exported as arrays (not just
 * unions) so stored blobs are validated against the same list the UI renders
 * from — a hand-copied duplicate silently falls back to defaults when a
 * dimension is added.
 */
export const SORT_KEYS = ['size', 'name', 'addr', 'section', 'object', 'kind'] as const;

export type SortKey = (typeof SORT_KEYS)[number];

export const GROUP_KEYS = ['none', 'object', 'archive', 'kind', 'directory', 'outSection'] as const;

export type GroupBy = (typeof GROUP_KEYS)[number];

export interface UiState {
    sortKey: SortKey;
    sortDir: 'asc' | 'desc';
    filterText: string;
    kinds: Record<SymbolKind, boolean>;
    minSize: number;
    groupBy: GroupBy;
    demangle: boolean;
    /** Address column shows the load address (LMA) instead of the runtime address (VMA). */
    showLma: boolean;
    hideSystem: boolean;
    showDiscarded: boolean;
}

export interface PersistedViewState {
    /** Schema version: a blob written by an older build is ignored, not misread. */
    v: number;
    ui: UiState;
    collapsed: string[];
    view: 'list' | 'treemap';
    /** Treemap drill-down, so a reload does not drop you back at the top level. */
    treemapGroupKey: string | null;
    /** Column widths in fr units. */
    cols: number[];
    scrollTop: number;
    /** Indices into the rendered row list (only meaningful for `symbolCount`). */
    selected: number[];
    /** Symbol count of the document `selected` was taken from. */
    symbolCount: number;
}

/** Current `PersistedViewState.v`. */
export const VIEW_STATE_VERSION = 1;

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
