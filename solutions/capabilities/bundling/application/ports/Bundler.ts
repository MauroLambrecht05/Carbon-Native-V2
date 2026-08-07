// The Bundler port.
//
// The build pipeline decides *what* to build — which entry, which backend,
// whether the cache is warm. How the bytes are produced is an adapter: today
// Bun.build with a Babel chain, which is 64 KB of Bun-specific machinery.
//
// This interface is the seam that keeps that decision reversible. It is not
// yet implemented by bun-bundler.ts, which the pipeline still imports directly
// and lazily; declaring the port first is the honest half-step, and it names
// what a second backend (esbuild under Node, say) would have to satisfy.

export interface BundleRequest {
  readonly projectDir: string;
  readonly entry: string;
  readonly outFile: string;
  readonly minify?: boolean;
  readonly bytecode?: boolean;
}

export interface Bundler {
  bundle(request: BundleRequest): Promise<void>;
}
