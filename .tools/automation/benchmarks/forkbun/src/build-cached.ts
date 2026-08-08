/*
 * Content-addressed build cache wrapping electrobun build.
 *
 * Hashes (config + sources + electrobun-CLI version) → cache key.
 * If hit, copies cached output back to ./build/. Skips electrobun.exe.
 * If miss, runs electrobun build then archives the output keyed by hash.
 *
 *   bun build-cached.ts            -> dev build with cache
 *   bun build-cached.ts --env=stable
 *   bun build-cached.ts --no-cache -> bypass for benchmarking
 *
 * Cache lives at ./.buildcache/<hash>/
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
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";

const args = process.argv.slice(2);
const noCache = args.includes("--no-cache");
const env = args.find((a) => a.startsWith("--env="))?.split("=")[1] ?? "dev";

const cwd = process.cwd();
const cacheDir = join(cwd, ".buildcache");
const buildDir = join(cwd, "build");

const ELECTROBUN =
	process.env.ELECTROBUN ??
	join(cwd, "node_modules", "electrobun", "bin", "electrobun.exe");

function hashFile(p: string, h: ReturnType<typeof createHash>) {
	h.update(p.replace(cwd, "")); // path relative
	h.update(readFileSync(p));
}

function walk(root: string, ignoreDirs: Set<string>): string[] {
	const out: string[] = [];
	function rec(d: string) {
		for (const item of readdirSync(d)) {
			const abs = join(d, item);
			const st = statSync(abs);
			if (st.isDirectory()) {
				if (!ignoreDirs.has(item)) rec(abs);
			} else {
				out.push(abs);
			}
		}
	}
	rec(root);
	return out;
}

function computeCacheKey(): string {
	const ignore = new Set([
		"node_modules",
		"build",
		".buildcache",
		".git",
		"dist",
		"artifacts",
	]);
	const files = walk(cwd, ignore).sort();

	const h = createHash("sha256");
	h.update(`env=${env}`);

	// Hash the source tree
	for (const f of files) {
		hashFile(f, h);
	}

	// Hash the CLI version (so cache invalidates when CLI updates)
	if (existsSync(ELECTROBUN)) {
		// Just hash the file size + mtime as a cheap fingerprint
		const st = statSync(ELECTROBUN);
		h.update(`cli:${st.size}:${st.mtimeMs}`);
	}

	return h.digest("hex").slice(0, 16);
}

function main() {
	mkdirSync(cacheDir, { recursive: true });

	const t0 = performance.now();
	const key = computeCacheKey();
	const tHash = performance.now() - t0;

	const cacheBucket = join(cacheDir, key);

	console.error(`[cache] env=${env} key=${key}  hash_compute=${tHash.toFixed(0)}ms`);

	if (!noCache && existsSync(cacheBucket) && existsSync(join(cacheBucket, ".done"))) {
		// Cache hit — restore
		const restoreStart = performance.now();
		if (existsSync(buildDir)) rmSync(buildDir, { recursive: true, force: true });
		cpSync(join(cacheBucket, "build"), buildDir, { recursive: true });
		const tRestore = performance.now() - restoreStart;
		const total = performance.now() - t0;
		console.error(
			`[cache] HIT  restore=${tRestore.toFixed(0)}ms  total=${total.toFixed(0)}ms`,
		);
		console.log(
			JSON.stringify({
				cache: "hit",
				key,
				hash_ms: Math.round(tHash),
				restore_ms: Math.round(tRestore),
				total_ms: Math.round(total),
				env,
			}),
		);
		return;
	}

	// Cache miss — run electrobun
	console.error(`[cache] MISS — running electrobun build`);
	const buildStart = performance.now();
	const r = spawnSync(
		ELECTROBUN,
		env === "dev" ? ["build"] : ["build", `--env=${env}`],
		{ stdio: "inherit" },
	);
	const tBuild = performance.now() - buildStart;
	if (r.status !== 0) {
		console.error(`[cache] electrobun failed status=${r.status}`);
		process.exit(r.status ?? 1);
	}

	// Archive the result
	const archiveStart = performance.now();
	if (existsSync(cacheBucket)) rmSync(cacheBucket, { recursive: true, force: true });
	mkdirSync(cacheBucket, { recursive: true });
	cpSync(buildDir, join(cacheBucket, "build"), { recursive: true });
	writeFileSync(
		join(cacheBucket, ".done"),
		JSON.stringify({ key, env, createdAt: new Date().toISOString() }),
	);
	const tArchive = performance.now() - archiveStart;
	const total = performance.now() - t0;
	console.error(
		`[cache] STORED  build=${tBuild.toFixed(0)}ms  archive=${tArchive.toFixed(0)}ms  total=${total.toFixed(0)}ms`,
	);
	console.log(
		JSON.stringify({
			cache: "miss",
			key,
			hash_ms: Math.round(tHash),
			build_ms: Math.round(tBuild),
			archive_ms: Math.round(tArchive),
			total_ms: Math.round(total),
			env,
		}),
	);
}

main();
