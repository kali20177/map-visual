/**
 * Heuristic source-file lookup from a linker-map object reference (M5).
 * Pure pattern generation lives here (unit-tested); the IO side (findFiles,
 * opening the file) is in mapEditor.ts.
 *
 * Object references come in several shapes:
 *   main.o                      → main.c / main.cpp / ...
 *   main.cpp.o                  → main.cpp (suffix .o stripped first)
 *   /tmp/ccAbCdEf.o             → no meaningful stem, nothing to find
 *   libutil.a(lib.o)            → lib.c / lib.cpp / ...
 *   /path/libgcc.a(unwind-arm.o)→ findable in theory, usually vendored —
 *                                 still searched in the workspace only.
 */

const OBJECT_SUFFIXES = /\.(o|obj|objd)$/i;
const SOURCE_EXTENSIONS = ['c', 'cc', 'cpp', 'cxx', 'c++', 'm', 'mm', 's', 'S'];

/** Strip an `archive(member)` wrapper and object suffixes down to a base name. */
export function objectStem(object: string, member: string | null): string | null {
    let raw = member ?? object;
    if (!raw) {
        return null;
    }
    if (!member) {
        const archiveMatch = /^(.*\.a)\((.+)\)$/.exec(raw);
        if (archiveMatch) {
            raw = archiveMatch[2];
        }
    }
    const slash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
    const base = slash >= 0 ? raw.slice(slash + 1) : raw;
    if (!base || OBJECT_SUFFIXES.test(base) === false) {
        // not an object file at all ("linker stubs", "[pad]", ...)
        return null;
    }
    const withoutObj = base.replace(OBJECT_SUFFIXES, '');
    if (!withoutObj) {
        return null;
    }
    // gcc/clang temporaries like ccAbCdEf.o have no workspace source
    if (/^cc[A-Za-z0-9+_-]+$/.test(withoutObj)) {
        return null;
    }
    // LTO intermediates (.ltrans0.ltrans.o) have no direct source
    if (/\.ltrans\d*$/i.test(withoutObj) || withoutObj.endsWith('.res')) {
        return null;
    }
    return withoutObj;
}

/** Glob patterns to try, most specific first. */
export function sourceGlobPatterns(object: string, member: string | null): string[] {
    const stem = objectStem(object, member);
    if (!stem) {
        return [];
    }
    const ext = (stem.match(/\.([a-zA-Z0-9+]+)$/) ?? [])[1];
    const patterns: string[] = [];
    if (ext && SOURCE_EXTENSIONS.includes(ext.toLowerCase())) {
        // stem already carries a source extension (main.cpp) — exact hit first
        patterns.push(`**/${stem}`);
    }
    const extAlternation = SOURCE_EXTENSIONS.join(',');
    patterns.push(`**/${stem}.{${extAlternation}}`);
    return patterns;
}

/** Sort candidates: shallow paths first, then shorter — workspace-local beats vendored. */
export function rankCandidates(paths: string[]): string[] {
    return [...paths].sort((a, b) => {
        const depthA = a.split('/').length;
        const depthB = b.split('/').length;
        if (depthA !== depthB) {
            return depthA - depthB;
        }
        return a.length - b.length;
    });
}
