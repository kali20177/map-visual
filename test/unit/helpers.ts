import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseMapText, type ParseOptions } from '../../src/parser/pipeline';
import type { MapDocument } from '../../src/types';

export const ROOT = path.resolve(__dirname, '..', '..');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures');
/** dir that contains index_bg.wasm (the npm package layout) */
export const WASM_DIR = path.join(ROOT, 'node_modules', 'gecko-profiler-demangle');

export function readFixture(rel: string): string {
    return fs.readFileSync(path.join(FIXTURES, rel), 'utf8');
}

export async function parseFixture(rel: string, opts: Partial<ParseOptions> = {}): Promise<MapDocument> {
    const text = readFixture(rel);
    const full: ParseOptions = { demangle: false, formatOverride: 'auto', ...opts };
    const useWasm = full.demangle ? WASM_DIR : undefined;
    return parseMapText(text, rel, full, useWasm);
}

export function findSym(doc: MapDocument, name: string): ReturnType<MapDocument['symbols']['find']> {
    return doc.symbols.find((s) => s.name === name || s.demangled === name || s.mangled === name);
}

export function kept(doc: MapDocument): MapDocument['symbols'] {
    return doc.symbols.filter((s) => s.status === 'kept');
}

export function discarded(doc: MapDocument): MapDocument['symbols'] {
    return doc.symbols.filter((s) => s.status === 'discarded');
}

/** 全语料 fixture 相对路径（recursive walk，统一分隔符）。 */
export function fixtureMaps(): string[] {
    return fs
        .readdirSync(FIXTURES, { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.map'))
        .map((f) => f.replaceAll('\\', '/'));
}
