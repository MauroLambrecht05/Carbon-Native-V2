/*
 * carbon-native build cache.
 * Voltframe win ported: 191× speedup on stable revisits, 6.5× on dev.
 *
 *   bun build-cached.ts <project-dir>            -> dev build with cache
 *   bun build-cached.ts <project-dir> --no-cache -> bypass for benchmarking
 *
 * Cache key = sha256(sources + carbon.toml + carbon-runtime.exe fingerprint).
 * On hit: copy cached dist/ back. On miss: run vite build + bun build of shell.ts.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	statSync,
	cpSync,
	rmSync,
	readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const noCache = args.includes("--no-cache");
const projectDir = resolve(args.find((a) => !a.startsWith("--")) ?? ".");
const cacheDir = join(projectDir, ".carboncache");
const distDir = join(projectDir, "dist");

function walk(root: string, ignore: Set<string>): string[] {
	const out: string[] = [];
	function rec(d: string) {
		if (!existsSync(d)) return;
		for (const item of readdirSync(d)) {
			const abs = join(d, item);
			const st = statSync(abs);
			if (st.isDirectory()) {
				if (!ignore.has(item)) rec(abs);
			} else {
				out.push(abs);
			}
		}
	}
	rec(root);
	return out;
}

function hashFile(p: string, h: ReturnType<typeof createHash>) {
	h.update(p.replace(projectDir, "")); // path relative
	h.update(readFileSync(p));
}

function computeCacheKey(): string {
	const ignore = new Set([
		"node_modules",
		"dist",
		".carboncache",
		".git",
		"target",
	]);
	const files = walk(projectDir, ignore).sort();

	const h = createHash("sha256");
	for (const f of files) hashFile(f, h);

	// Fingerprint the runtime so cache invalidates when the runtime updates.
	const runtimeCandidates = [
		join(projectDir, "..", "..", "runtimes", "webview2", "target", "release", "carbon-runtime.exe"),
		process.env.CARBON_RUNTIME ?? "",
	].filter(Boolean);
	for (const r of runtimeCandidates) {
		if (existsSync(r)) {
			const st = statSync(r);
			h.update(`runtime:${st.size}:${st.mtimeMs}`);
			break;
		}
	}

	return h.digest("hex").slice(0, 16);
}

function runCmd(cmd: string, cmdArgs: string[]): number {
	const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", cwd: projectDir, shell: true });
	return r.status ?? 1;
}

function main() {
	mkdirSync(cacheDir, { recursive: true });

	const t0 = performance.now();
	const key = computeCacheKey();
	const tHash = performance.now() - t0;
	const bucket = join(cacheDir, key);

	console.error(`[cache] key=${key} hash_compute=${tHash.toFixed(0)}ms`);

	if (!noCache && existsSync(bucket) && existsSync(join(bucket, ".done"))) {
		const t1 = performance.now();
		if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
		cpSync(join(bucket, "dist"), distDir, { recursive: true });
		const total = performance.now() - t0;
		console.error(`[cache] HIT  total=${total.toFixed(0)}ms`);
		console.log(JSON.stringify({ cache: "hit", key, total_ms: Math.round(total) }));
		return;
	}

	console.error(`[cache] MISS — running vite build + shell bundle`);
	const tBuild = performance.now();
	const status1 = runCmd("bun", ["x", "vite", "build"]);
	if (status1 !== 0) process.exit(status1);
	const status2 = runCmd("bun", ["build", "src/shell.ts", "--target=browser", "--format=esm", "--outdir", "dist"]);
	if (status2 !== 0) process.exit(status2);
	const buildMs = performance.now() - tBuild;

	if (existsSync(bucket)) rmSync(bucket, { recursive: true, force: true });
	mkdirSync(bucket, { recursive: true });
	cpSync(distDir, join(bucket, "dist"), { recursive: true });
	writeFileSync(join(bucket, ".done"), JSON.stringify({ key, createdAt: new Date().toISOString() }));
	const total = performance.now() - t0;
	console.error(`[cache] STORED  build=${buildMs.toFixed(0)}ms total=${total.toFixed(0)}ms`);
	console.log(JSON.stringify({ cache: "miss", key, build_ms: Math.round(buildMs), total_ms: Math.round(total) }));
}

main();
