import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MapDocument } from '../types';
import { detectFormat } from './detect';
import { parseGnuLd } from './gnuld';
import { parseLld } from './lld';
import { Warnings } from './warnings';
import { Demangler, demanglerAvailable, initDemangler, isMangled } from '../demangle';
import { finalize } from '../analysis/analyze';

export interface ParseOptions {
    demangle: boolean;
    formatOverride: 'auto' | 'gnu-ld' | 'lld';
}

export class MapParseError extends Error {
    constructor(
        public readonly kind: 'notfound' | 'json' | 'unsupported' | 'unknown' | 'io',
        message: string,
    ) {
        super(message);
    }
}

const SYSTEM_RE =
    /(^|[/\\])(crt[a-z0-9_.+-]*|Scrt1|crt1)\.o$|crtbegin|crtend|libgcc|libstdc\+\+|libnosys|newlib|picolibc|linker stubs|[/\\]lib[/\\]gcc[/\\]|arm-none-eabi[/\\]lib|llvm[^/\\]*[/\\]lib[/\\]/i;
const LTO_OBJ_RE = /\.ltrans\d*\.o$|\.res\.o$|[/\\]ltrans/i;

const demangler = new Demangler();

export async function parseMapFile(
    filePath: string,
    opts: ParseOptions,
    wasmDir?: string,
): Promise<MapDocument> {
    let text: string;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            throw new MapParseError('notfound', `file not found: ${filePath}`);
        }
        throw new MapParseError('io', `cannot read ${filePath}: ${(e as Error).message}`);
    }
    if (text.trim().length === 0) {
        throw new MapParseError('unknown', 'file is empty');
    }
    return parseMapText(text, filePath, opts, wasmDir);
}

export async function parseMapText(
    text: string,
    file: string,
    opts: ParseOptions,
    wasmDir?: string,
): Promise<MapDocument> {
    const detection = detectFormat(text);

    if (detection.jsonSourcemap) {
        throw new MapParseError('json', 'This looks like a JSON file (probably a JS sourcemap), not a linker map.');
    }
    if (detection.format === 'armlink' || detection.format === 'ilink') {
        throw new MapParseError('unsupported', `Keil/IAR map support is on the roadmap; detected: ${detection.format} (${detection.reason})`);
    }
    let format = detection.format;
    if (opts.formatOverride === 'gnu-ld' || opts.formatOverride === 'lld') {
        format = opts.formatOverride;
    }
    if (format !== 'gnu-ld' && format !== 'lld') {
        throw new MapParseError('unknown', `Could not identify the map format (${detection.reason}). Try setting "mapvisual.formatOverride".`);
    }

    if (opts.demangle && wasmDir) {
        await initDemangler(path.join(wasmDir, 'index_bg.wasm'));
    }

    const warnings = new Warnings();
    const parsed = format === 'lld' ? parseLld(text, warnings) : parseGnuLd(text, warnings);

    for (const sym of parsed.symbols) {
        sym.isSystem = SYSTEM_RE.test(sym.object) || (sym.archive != null && SYSTEM_RE.test(sym.archive));
        sym.isLto = LTO_OBJ_RE.test(sym.object);
        if (sym.mangled == null && isMangled(sym.name)) {
            sym.mangled = sym.name;
        }
        if (opts.demangle && sym.mangled != null) {
            sym.demangled = demangler.demangle(sym.mangled);
        }
    }
    if (opts.demangle && !demanglerAvailable()) {
        warnings.add('demangler unavailable (WASM module failed to load) — mangled names kept as-is');
    }

    const doc: MapDocument = {
        format,
        file,
        regions: parsed.regions,
        symbols: parsed.symbols,
        totals: {
            flash: 0,
            ram: 0,
            keptCount: 0,
            discardedCount: 0,
            fillTotal: 0,
            kindTotals: { code: 0, rodata: 0, data: 0, bss: 0, meta: 0, pad: 0, other: 0 },
            regions: [],
        },
        warnings: warnings.list(),
    };
    return finalize(doc);
}
