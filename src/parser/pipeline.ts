import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MapDocument } from '../types';
import type { ProgressStage } from '../protocol';
import { detectFormat } from './detect';
import { Warnings } from './warnings';
import { Demangler, demanglerAvailable, extractSectionSymbol, initDemangler, isMangled } from '../demangle';
import { finalize } from '../analysis/analyze';
import { getParser, PLANNED_FORMATS } from './registry';

export interface ParseOptions {
    demangle: boolean;
    formatOverride: 'auto' | 'gnu-ld' | 'lld';
}

/**
 * Reported stage is one of `PROGRESS_STAGES` rather than free prose: the host
 * translates it for the progress notification, and the union keeps a new stage
 * from reaching the UI untranslated (the CLI prints the raw value).
 */
export type ProgressFn = (stage: ProgressStage, pct: number) => void;

export class MapParseError extends Error {
    constructor(
        public readonly kind: 'notfound' | 'json' | 'unsupported' | 'unknown' | 'io',
        message: string,
    ) {
        super(message);
    }
}

const SYSTEM_RE =
    /(^|[/\\])(crt[a-z0-9_.+-]*|Scrt1|crt1)\.o$|crtbegin|crtend|libgcc|libclang_rt|libstdc\+\+|libnosys|newlib|picolibc|linker stubs|[/\\]lib[/\\]gcc[/\\]|arm-none-eabi[/\\]lib|llvm[^/\\]*[/\\]lib[/\\]/i;
// LTO artifacts: GNU ld's post-LTO split objects (ltrans/res) and lld's
// synthetic whole-program objects — full LTO renames the input to
// `<output>.elf.lto.o`, ThinLTO to `<output>.elf.lto.<file>.o` (verified
// against ld.lld 23.1.2 map files).
const LTO_OBJ_RE = /\.ltrans\d*\.o$|\.res\.o$|[/\\]ltrans|\.lto(\.[^./\\]+)?\.o$/i;

const demangler = new Demangler();

export async function parseMapFile(
    filePath: string,
    opts: ParseOptions,
    wasmDir?: string,
    onProgress?: ProgressFn,
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
    return parseMapText(text, filePath, opts, wasmDir, onProgress);
}

export async function parseMapText(
    text: string,
    file: string,
    opts: ParseOptions,
    wasmDir?: string,
    onProgress?: ProgressFn,
): Promise<MapDocument> {
    const progress = onProgress ?? (() => undefined);
    const detection = detectFormat(text);
    progress('detecting format', 15);

    if (detection.jsonSourcemap) {
        throw new MapParseError('json', 'This looks like a JSON file (probably a JS sourcemap), not a linker map.');
    }
    let format = detection.format;
    if (opts.formatOverride === 'gnu-ld' || opts.formatOverride === 'lld') {
        format = opts.formatOverride;
    }

    if (opts.demangle && wasmDir) {
        await initDemangler(path.join(wasmDir, 'index_bg.wasm'));
    }

    const parser = getParser(format);
    if (!parser) {
        const planned = PLANNED_FORMATS.get(format);
        if (planned) {
            throw new MapParseError('unsupported', planned);
        }
        throw new MapParseError('unknown', `Could not identify the map format (${detection.reason}). Try setting "mapvisual.formatOverride".`);
    }

    progress('parsing symbols', 35);
    const warnings = new Warnings();
    const parsed = parser.parse(text, warnings);
    if (parsed.symbols.length === 0) {
        // 零行 = "0 B 固件 + 零告警" 的静默错答：auto 检测被头部锚点误导
        // （如文件被截断、内容被裁剪），或强制格式猜错时都要说一声
        warnings.add(opts.formatOverride !== 'auto' ? 'formatOverrideNoRows' : 'noRowsParsed', {
            params: opts.formatOverride !== 'auto' ? [opts.formatOverride] : undefined,
        });
    }
    progress('demangling', 65);

    for (const sym of parsed.symbols) {
        sym.isSystem = SYSTEM_RE.test(sym.object) || (sym.archive != null && SYSTEM_RE.test(sym.archive));
        sym.isLto = LTO_OBJ_RE.test(sym.object);
        if (sym.mangled == null) {
            // A symbol line inside a mangled section (`.text._ZN3app4mainEv`) only
            // ever shows the demangled form — recover the mangled name from the
            // section before falling back to the raw symbol name.
            sym.mangled = extractSectionSymbol(sym.section) ?? (isMangled(sym.name) ? sym.name : null);
        }
        if (opts.demangle && sym.mangled != null) {
            sym.demangled = demangler.demangle(sym.mangled);
        }
    }
    if (opts.demangle && !demanglerAvailable()) {
        warnings.add('demanglerUnavailable');
    }
    progress('analyzing regions', 85);

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
    finalize(doc, warnings);
    // finalize 内部(区域角色冲突检查)可能补充告警 — list() 是快照，须重取
    doc.warnings = warnings.list();
    progress('done', 100);
    return doc;
}
