import { WARNING_TEMPLATES, type ParseWarning, type WarningCode } from '../types';

interface Detail {
    /** Values for the template's `{0}`… placeholders. */
    params?: Array<string | number>;
    sample?: string;
    /** 1-based source line, when the warning comes from a specific line. */
    line?: number;
}

interface Entry {
    message: string;
    code: WarningCode;
    params?: Array<string | number>;
    count: number;
    samples: string[];
    firstLine?: number;
}

/** Fill `{0}`… from `params`; placeholders without a value are left as-is. */
function render(template: string, params?: Array<string | number>): string {
    if (!params || params.length === 0) {
        return template;
    }
    return template.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
        const value = params[Number(index)];
        return value == null ? placeholder : String(value);
    });
}

/**
 * Collects parse anomalies: dedup by message, capped samples per message.
 *
 * Callers pass a code, never prose: the English `message` is rendered here from
 * `WARNING_TEMPLATES` (the CLI consumes it verbatim) and the code + params
 * travel with it so the webview can render the same warning in its own
 * language.
 */
export class Warnings {
    private map = new Map<string, Entry>();

    add(code: WarningCode, detail: Detail = {}): void {
        const message = render(WARNING_TEMPLATES[code], detail.params);
        let entry = this.map.get(message);
        if (!entry) {
            entry = { message, code, params: detail.params, count: 0, samples: [] };
            this.map.set(message, entry);
        }
        entry.count++;
        const { sample, line } = detail;
        if (sample && entry.samples.length < 3) {
            entry.samples.push(sample.length > 120 ? sample.slice(0, 117) + '...' : sample);
        }
        if (line != null && entry.firstLine == null) {
            entry.firstLine = line;
        }
    }

    list(): ParseWarning[] {
        return [...this.map.values()]
            .sort((a, b) => b.count - a.count)
            .map(({ message, code, params, count, samples, firstLine }) => ({ message, code, params, count, samples, line: firstLine }));
    }
}
