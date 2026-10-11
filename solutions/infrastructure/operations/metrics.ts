// Counters, gauges and histograms, written in the Prometheus text format.
// In-process and unshared: each process reports its own, and the collector
// that scrapes them adds them up.

export interface Sample { readonly name: string; readonly help: string; readonly type: "counter" | "gauge"; readonly labels?: Readonly<Record<string, string>>; readonly value: number }
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
/** The most series one metric keeps. The last of them is the one every further label set is counted under, so a label can never grow a metric without bound. */
const MAX_SERIES = 2000;

const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labelText = (labels: Readonly<Record<string, string>>) => { const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1)); return entries.length ? `{${entries.map(([key, value]) => `${key}="${escape(value)}"`).join(",")}}` : ""; };

export class Metrics {
  private readonly counters = new Map<string, { help: string; series: Map<string, { labels: Record<string, string>; value: number }> }>();
  private readonly histograms = new Map<string, { help: string; series: Map<string, { labels: Record<string, string>; buckets: number[]; sum: number; count: number }> }>();

  private series<T>(family: Map<string, T>, labels: Record<string, string>, make: (labels: Record<string, string>) => T): T {
    let key = labelText(labels);
    if (!family.has(key) && family.size >= MAX_SERIES - 1) { labels = Object.fromEntries(Object.keys(labels).map(name => [name, "other"])); key = labelText(labels); }
    let entry = family.get(key); if (!entry) { entry = make(labels); family.set(key, entry); }
    return entry;
  }
  /** Adds to a counter. Names follow Prometheus: `carbon_http_requests_total`. */
  count(name: string, help: string, labels: Record<string, string> = {}, amount = 1): void {
    let family = this.counters.get(name); if (!family) { family = { help, series: new Map() }; this.counters.set(name, family); }
    this.series(family.series, labels, kept => ({ labels: kept, value: 0 })).value += amount;
  }
  /** Records one duration, in seconds. */
  time(name: string, help: string, labels: Record<string, string>, seconds: number): void {
    let family = this.histograms.get(name); if (!family) { family = { help, series: new Map() }; this.histograms.set(name, family); }
    const entry = this.series(family.series, labels, kept => ({ labels: kept, buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }));
    for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]!) entry.buckets[i]!++;
    entry.sum += seconds; entry.count++;
  }

  /** Everything recorded, plus the samples given (values read at this moment, such as queue depths). */
  render(extra: readonly Sample[] = []): string {
    const lines: string[] = [];
    for (const [name, family] of [...this.counters].sort(([a], [b]) => (a < b ? -1 : 1))) {
      lines.push(`# HELP ${name} ${family.help}`, `# TYPE ${name} counter`);
      for (const entry of family.series.values()) lines.push(`${name}${labelText(entry.labels)} ${entry.value}`);
    }
    for (const [name, family] of [...this.histograms].sort(([a], [b]) => (a < b ? -1 : 1))) {
      lines.push(`# HELP ${name} ${family.help}`, `# TYPE ${name} histogram`);
      for (const entry of family.series.values()) {
        BUCKETS.forEach((bound, index) => lines.push(`${name}_bucket${labelText({ ...entry.labels, le: String(bound) })} ${entry.buckets[index]}`));
        lines.push(`${name}_bucket${labelText({ ...entry.labels, le: "+Inf" })} ${entry.count}`, `${name}_sum${labelText(entry.labels)} ${entry.sum}`, `${name}_count${labelText(entry.labels)} ${entry.count}`);
      }
    }
    const seen = new Set<string>();
    for (const sample of extra) {
      if (!/^[a-z_][a-z0-9_]*$/.test(sample.name) || !Number.isFinite(sample.value)) continue;
      if (!seen.has(sample.name)) { seen.add(sample.name); lines.push(`# HELP ${sample.name} ${sample.help}`, `# TYPE ${sample.name} ${sample.type}`); }
      lines.push(`${sample.name}${labelText(sample.labels ?? {})} ${sample.value}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
