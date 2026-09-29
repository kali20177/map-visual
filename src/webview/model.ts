import type { GroupBy, MapDocument, SortKey, SymbolRecord, UiState } from '../types';

/**
 * Pure view-model for the webview: filtering, sorting, grouping, formatting.
 * No DOM / vscode API access here so it can be unit-tested in Node.
 *
 * `SortKey` / `GroupBy` / `UiState` are re-exported for the webview's own
 * import sites; they live in types.ts because the host also round-trips them
 * as part of the persisted view state.
 */

export type { GroupBy, SortKey, UiState } from '../types';

export const DEFAULT_UI_STATE: UiState = {
    sortKey: 'size',
    sortDir: 'desc',
    filterText: '',
    // meta (debug/annotation, non-alloc) is folded by default per FORMATS §1.6
    kinds: { code: true, rodata: true, data: true, bss: true, meta: false, pad: true, other: true },
    minSize: 0,
    groupBy: 'none',
    demangle: true,
    hideSystem: false,
    showDiscarded: false,
};

export interface RowView {
    sym: SymbolRecord;
    display: string;
    secondary: string | null; // the other name form (mangled when showing demangled, etc.)
}

export interface GroupView {
    key: string;
    kind: 'group';
    label: string;
    size: number;
    count: number;
    rows: RowView[];
}

export interface FlatRow {
    kind: 'row';
    row: RowView;
}

export type ListItem = GroupView | FlatRow;

/** The name shown in the Symbol column for the current demangle setting. */
export function displayName(sym: SymbolRecord, demangle: boolean): string {
    if (!demangle) {
        return sym.mangled && sym.mangled !== sym.name ? sym.mangled : sym.name;
    }
    return sym.demangled ?? sym.name;
}

export function secondaryName(sym: SymbolRecord, demangle: boolean): string | null {
    const primary = displayName(sym, demangle);
    const other = demangle ? (sym.mangled ?? sym.name) : (sym.demangled ?? sym.name);
    return other !== primary ? other : null;
}

/** A parsed filter query: `include` terms are ANDed, `exclude` terms veto a row. */
export interface FilterTerms {
    include: string[];
    exclude: string[];
}

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';

/**
 * Tokenize a filter query. Whitespace separates terms, a leading `-` excludes,
 * and double quotes hold a phrase together — object names and paths carry
 * spaces (`linker stubs`, `My Project/build/x.o`), so `-"linker stubs"` has to
 * stay one term. Unterminated quotes take the rest of the query.
 */
export function parseFilterTerms(query: string): FilterTerms {
    const include: string[] = [];
    const exclude: string[] = [];
    let i = 0;
    while (i < query.length) {
        while (i < query.length && isSpace(query.charAt(i))) {
            i++;
        }
        if (i >= query.length) {
            break;
        }
        const negated = query.charAt(i) === '-';
        if (negated) {
            i++;
        }
        let term = '';
        if (query.charAt(i) === '"') {
            i++;
            const end = query.indexOf('"', i);
            term = end < 0 ? query.slice(i) : query.slice(i, end);
            i = end < 0 ? query.length : end + 1;
        } else {
            while (i < query.length && !isSpace(query.charAt(i))) {
                term += query.charAt(i);
                i++;
            }
        }
        const normalized = term.toLowerCase();
        if (normalized) {
            (negated ? exclude : include).push(normalized);
        }
    }
    return { include, exclude };
}

function matchesFilter(sym: SymbolRecord, ui: UiState, terms: FilterTerms): boolean {
    if (!ui.showDiscarded && sym.status === 'discarded') {
        return false;
    }
    if (ui.hideSystem && sym.isSystem && !sym.isFill) {
        return false;
    }
    if (!ui.kinds[sym.kind]) {
        return false;
    }
    if (sym.size < ui.minSize && !sym.isFill) {
        return false;
    }
    if (terms.include.length > 0 || terms.exclude.length > 0) {
        const hay = `${sym.name}\n${sym.demangled ?? ''}\n${sym.mangled ?? ''}\n${sym.section}\n${sym.object}`.toLowerCase();
        for (const term of terms.include) {
            if (!hay.includes(term)) {
                return false;
            }
        }
        for (const term of terms.exclude) {
            if (hay.includes(term)) {
                return false;
            }
        }
    }
    return true;
}

function sortKeyOf(sym: SymbolRecord, key: SortKey, demangle: boolean): string | number {
    switch (key) {
        case 'size':
            return sym.size;
        case 'addr':
            return sym.addr;
        case 'name':
            return displayName(sym, demangle).toLowerCase();
        case 'kind':
            return sym.kind;
        case 'section':
            return sym.section.toLowerCase();
        case 'object':
            return (sym.member ?? sym.object).toLowerCase();
    }
}

export function filterAndSort(doc: MapDocument, ui: UiState): RowView[] {
    // parsed once per pass — matchesFilter runs per symbol, this is the only
    // place the query string is tokenized
    const terms = parseFilterTerms(ui.filterText);
    const kept = doc.symbols.filter((s) => matchesFilter(s, ui, terms));
    const dir = ui.sortDir === 'asc' ? 1 : -1;
    const key = ui.sortKey;
    kept.sort((a, b) => {
        const ka = sortKeyOf(a, key, ui.demangle);
        const kb = sortKeyOf(b, key, ui.demangle);
        if (ka < kb) {
            return -dir;
        }
        if (ka > kb) {
            return dir;
        }
        // stable tie-break: size desc, then address
        if (a.size !== b.size) {
            return b.size - a.size;
        }
        return a.addr - b.addr;
    });
    return kept.map((sym) => ({ sym, display: displayName(sym, ui.demangle), secondary: secondaryName(sym, ui.demangle) }));
}

export function groupKeyOf(sym: SymbolRecord, groupBy: GroupBy): string {
    switch (groupBy) {
        case 'none':
            return '';
        case 'object':
            return sym.member ? `${baseName(sym.archive ?? '')} › ${sym.member}` : baseName(sym.object) || '(none)';
        case 'archive':
            return sym.archive ? baseName(sym.archive) : '(no archive)';
        case 'kind':
            return sym.kind;
        case 'outSection':
            // link-script granularity: `section` is the *input* section, so
            // grouping by it splits `.text` into one group per function
            return sym.outSection ?? (sym.section || '(none)');
        case 'directory': {
            const dir = directoryOf(sym.object);
            return dir || '(root)';
        }
    }
}

export function buildView(doc: MapDocument, ui: UiState): ListItem[] {
    const rows = filterAndSort(doc, ui);
    if (ui.groupBy === 'none') {
        return rows.map((row) => ({ kind: 'row' as const, row }));
    }
    const groups = new Map<string, RowView[]>();
    for (const row of rows) {
        const key = groupKeyOf(row.sym, ui.groupBy);
        let list = groups.get(key);
        if (!list) {
            list = [];
            groups.set(key, list);
        }
        list.push(row);
    }
    const sortedGroups = [...groups.entries()].sort((a, b) => {
        const sa = a[1].reduce((acc, r) => acc + r.sym.size, 0);
        const sb = b[1].reduce((acc, r) => acc + r.sym.size, 0);
        return sb - sa;
    });
    const items: ListItem[] = [];
    for (const [key, list] of sortedGroups) {
        items.push({
            kind: 'group',
            key: ui.groupBy + ':' + key,
            label: key,
            size: list.reduce((acc, r) => acc + r.sym.size, 0),
            count: list.length,
            rows: list,
        });
    }
    return items;
}

/** Flatten for rendering, honoring collapsed group keys. */
export function flattenItems(items: ListItem[], collapsed: Set<string>): Array<{ item: ListItem; depth: number; row?: RowView; group?: GroupView }> {
    const out: Array<{ item: ListItem; depth: number; row?: RowView; group?: GroupView }> = [];
    for (const item of items) {
        if (item.kind === 'group') {
            out.push({ item, depth: 0, group: item });
            if (!collapsed.has(item.key)) {
                for (const row of item.rows) {
                    out.push({ item, depth: 1, row });
                }
            }
        } else {
            out.push({ item, depth: 0, row: item.row });
        }
    }
    return out;
}

export function baseName(p: string): string {
    if (!p) {
        return '';
    }
    const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return slash >= 0 ? p.slice(slash + 1) : p;
}

export function directoryOf(p: string): string {
    if (!p) {
        return '';
    }
    const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return slash >= 0 ? p.slice(0, slash) : '';
}

export function formatBytes(n: number): string {
    if (n < 1024) {
        return `${n} B`;
    }
    if (n < 1024 * 1024) {
        return `${(n / 1024).toFixed(n < 10240 ? 2 : 1)} K`;
    }
    return `${(n / (1024 * 1024)).toFixed(2)} M`;
}

export function formatAddr(n: number): string {
    const hex = n.toString(16);
    const width = n > 0xffffffff ? 16 : 8;
    return '0x' + hex.padStart(width, '0');
}

export function toCsv(rows: RowView[], demangle: boolean): string {
    const esc = (v: string | number | null): string => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['size', 'size_hex', 'name', 'mangled', 'demangled', 'kind', 'section', 'object', 'archive', 'member', 'addr', 'lma', 'status'];
    const lines = [head.join(',')];
    for (const { sym } of rows) {
        lines.push(
            [
                sym.size,
                '0x' + sym.size.toString(16),
                esc(displayName(sym, demangle)),
                esc(sym.mangled),
                esc(sym.demangled),
                sym.kind,
                esc(sym.section),
                esc(sym.object),
                esc(sym.archive),
                esc(sym.member),
                esc(formatAddr(sym.addr)),
                sym.lma != null ? esc(formatAddr(sym.lma)) : '',
                sym.status,
            ].join(','),
        );
    }
    return lines.join('\n') + '\n';
}
