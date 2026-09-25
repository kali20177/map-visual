import type { MapFormat } from '../types';

export interface Detection {
    format: MapFormat;
    confidence: number;
    reason: string;
    /** Content looks like a JSON file (likely a JS sourcemap), not a linker map. */
    jsonSourcemap: boolean;
}

const LLD_HEADER_RE = /^\s*VMA\s+LMA\s+Size\s+Align\s+Out\s+In\s+Symbol\s*$/m;
const ARMLINK_RE = /Image component sizes|Memory Map of the image|Image Symbol Table|Section Cross References/;
const ILINK_RE = /ENTRY LIST|MODULE SUMMARY|IAR (ILINK|Systems)/;

/**
 * Two-stage detection: cheap first-line veto, then content signatures.
 * See docs/FORMATS.md §5. `full` may be the whole text; detection only needs
 * the first few KiB but the GNU anchors can sit deeper in some layouts.
 */
export function detectFormat(full: string): Detection {
    const head = full.slice(0, 8192);

    if (head.trimStart().startsWith('{')) {
        return { format: 'unknown', confidence: 0.99, reason: 'content is a JSON document (likely a JS sourcemap), not a linker map', jsonSourcemap: true };
    }
    if (LLD_HEADER_RE.test(head)) {
        return { format: 'lld', confidence: 0.95, reason: 'lld tabular map header (VMA/LMA/Size/Align/Out/In/Symbol)', jsonSourcemap: false };
    }
    if (ARMLINK_RE.test(head)) {
        return { format: 'armlink', confidence: 0.95, reason: 'armlink section headers (Image Symbol Table / Memory Map of the image)', jsonSourcemap: false };
    }
    if (ILINK_RE.test(head)) {
        return { format: 'ilink', confidence: 0.8, reason: 'IAR ilink markers', jsonSourcemap: false };
    }
    if (full.includes('Linker script and memory map') || full.includes('Memory Configuration') || /^LOAD /m.test(head) || head.includes('Archive member included')) {
        return { format: 'gnu-ld', confidence: 0.9, reason: 'GNU ld anchors (Linker script and memory map / Memory Configuration / LOAD)', jsonSourcemap: false };
    }
    return { format: 'unknown', confidence: 0, reason: 'no known format signature', jsonSourcemap: false };
}
