import type { ParseWarning } from '../types';

/** Collects parse anomalies: dedup by message, capped samples per message. */
export class Warnings {
    private map = new Map<string, { message: string; count: number; samples: string[]; firstLine?: number }>();

    add(message: string, sample?: string, line?: number): void {
        let entry = this.map.get(message);
        if (!entry) {
            entry = { message, count: 0, samples: [] };
            this.map.set(message, entry);
        }
        entry.count++;
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
            .map(({ message, count, samples, firstLine }) => ({ message, count, samples, line: firstLine }));
    }
}
