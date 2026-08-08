/*
 * Layered + uncompressed-bsdiff publish tool.
 * Replaces electrobun's broken patch generation.
 *
 *   bun publish.ts <oldDir> <newDir> <outDir>
 *
 * Inputs are two electrobun stable build directories (containing *-Setup.tar.zst).
 * Output: layered manifest + per-layer tarballs + delta patches.
 *
 * Patches are bsdiff'd against UNCOMPRESSED tars, then zstd-compressed for transport.
 * This produces ~247-byte patches for trivial JS changes vs the CLI's 2.75 MB.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, copyFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const BSDIFF =
	process.env.BSDIFF ??
	"C:\\Users\\mauro\\Desktop\\electrobun-bench\\app\\node_modules\\electrobun\\dist-win-x64\\bsdiff.exe";
const ZSTD =
	process.env.ZSTD ??
	"C:\\Users\\mauro\\Desktop\\electrobun-bench\\app\\node_modules\\electrobun\\dist-win-x64\\zig-zstd.exe";

interface LayerSpec {
	name: string;
	matcher: (relPath: string) => boolean;
}

// Default layer scheme — apps can override by config later.
// More-specific matchers come first.
const DEFAULT_LAYERS: LayerSpec[] = [
	{ name: "runtime", matcher: (p) => p === "bin/bun.exe" || p === "bin/bun" },
	{
		name: "native",
		matcher: (p) =>
			p.startsWith("bin/") &&
			(p.endsWith(".dll") ||
				p.endsWith(".dylib") ||
				p.endsWith(".so") ||
				p === "bin/launcher.exe" ||
				p === "bin/launcher" ||
				p === "bin/extractor.exe" ||
				p === "bin/extractor" ||
				p === "bin/process_helper.exe" ||
				p === "bin/process_helper" ||
				p === "bin/bsdiff.exe" ||
				p === "bin/bspatch.exe" ||
				p === "bin/zig-zstd.exe"),
	},
	{
		name: "framework",
		matcher: (p) =>
			p === "Resources/main.js" || p === "Resources/app/bun/index.js",
	},
	{
		name: "app",
		matcher: (p) =>
			p.startsWith("Resources/app/views/") || p.startsWith("Resources/app/"),
	},
	{ name: "meta", matcher: () => true }, // catch-all
];

interface FileEntry {
	relPath: string;
	absPath: string;
	size: number;
	hash: string;
}

function sha256File(path: string): string {
	const h = createHash("sha256");
	h.update(readFileSync(path));
	return h.digest("hex");
}

function listFiles(root: string): FileEntry[] {
	const entries: FileEntry[] = [];
	function walk(dir: string) {
		const items = require("node:fs").readdirSync(dir);
		for (const item of items) {
			const abs = join(dir, item);
			const st = statSync(abs);
			if (st.isDirectory()) walk(abs);
			else {
				const rel = abs.slice(root.length + 1).replace(/\\/g, "/");
				entries.push({
					relPath: rel,
					absPath: abs,
					size: st.size,
					hash: sha256File(abs),
				});
			}
		}
	}
	walk(root);
	return entries;
}

function classify(rel: string): string {
	for (const l of DEFAULT_LAYERS) if (l.matcher(rel)) return l.name;
	return "meta";
}

function makeTar(files: FileEntry[], outPath: string, baseDir: string) {
	// Use bun's spawnSync to call system `tar`. Native tar on Windows handles long paths fine.
	const fileList = files.map((f) => f.relPath).join("\n");
	const listFile = outPath + ".filelist";
	writeFileSync(listFile, fileList);
	const r = spawnSync(
		"tar",
		["-cf", outPath, "-C", baseDir, "-T", listFile],
		{ encoding: "utf8" },
	);
	if (r.status !== 0) {
		throw new Error(
			`tar failed: ${r.stderr}\n  status=${r.status}\n  files=${files.length}`,
		);
	}
	require("node:fs").unlinkSync(listFile);
}

function zstdCompress(input: string, output: string) {
	const r = spawnSync(
		ZSTD,
		["compress", "-i", input, "-o", output, "--no-timing"],
		{ encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`zstd compress failed: ${r.stderr}`);
}

function zstdDecompress(input: string, output: string) {
	const r = spawnSync(
		ZSTD,
		["decompress", "-i", input, "-o", output, "--no-timing"],
		{ encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`zstd decompress failed: ${r.stderr}`);
}

function bsdiff(from: string, to: string, patchOut: string) {
	const r = spawnSync(BSDIFF, [from, to, patchOut], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`bsdiff failed: ${r.stderr}`);
}

interface LayerManifest {
	name: string;
	hash: string;
	compressed_size: number;
	uncompressed_size: number;
	file_count: number;
	url: string;
}

interface BuildManifest {
	version: string;
	createdAt: string;
	layers: LayerManifest[];
	files: { path: string; layer: string; hash: string; size: number }[];
}

function buildLayered(
	srcDir: string,
	outDir: string,
	version: string,
): BuildManifest {
	mkdirSync(outDir, { recursive: true });
	const layersDir = join(outDir, "layers");
	mkdirSync(layersDir, { recursive: true });

	const files = listFiles(srcDir);

	// Group by layer
	const groups = new Map<string, FileEntry[]>();
	for (const f of files) {
		const layer = classify(f.relPath);
		if (!groups.has(layer)) groups.set(layer, []);
		groups.get(layer)!.push(f);
	}

	const manifest: BuildManifest = {
		version,
		createdAt: new Date().toISOString(),
		layers: [],
		files: files.map((f) => ({
			path: f.relPath,
			layer: classify(f.relPath),
			hash: f.hash,
			size: f.size,
		})),
	};

	for (const [name, entries] of groups) {
		// Tar then zstd
		const layerTar = join(layersDir, `${name}.tar`);
		const layerZst = join(layersDir, `${name}.tar.zst`);
		makeTar(entries, layerTar, srcDir);
		zstdCompress(layerTar, layerZst);
		const layerHash = sha256File(layerZst);
		const finalPath = join(layersDir, `${layerHash}.tar.zst`);
		copyFileSync(layerZst, finalPath);
		require("node:fs").unlinkSync(layerZst);
		// keep .tar around for diffing
		const finalTar = join(layersDir, `${layerHash}.tar`);
		copyFileSync(layerTar, finalTar);
		require("node:fs").unlinkSync(layerTar);

		manifest.layers.push({
			name,
			hash: layerHash,
			compressed_size: statSync(finalPath).size,
			uncompressed_size: statSync(finalTar).size,
			file_count: entries.length,
			url: `layers/${layerHash}.tar.zst`,
		});
	}

	writeFileSync(
		join(outDir, "manifest.json"),
		JSON.stringify(manifest, null, 2),
	);
	return manifest;
}

interface PatchInfo {
	layer: string;
	from_hash: string | null;
	to_hash: string;
	full_size: number;
	patch_size: number;
	patch_compressed_size: number;
	method: "patch" | "full";
	url: string;
}

function generatePatches(
	oldDir: string,
	newDir: string,
	outDir: string,
): { patches: PatchInfo[]; total_patch_bytes: number; total_full_bytes: number } {
	const oldManifest: BuildManifest = JSON.parse(
		readFileSync(join(oldDir, "manifest.json"), "utf8"),
	);
	const newManifest: BuildManifest = JSON.parse(
		readFileSync(join(newDir, "manifest.json"), "utf8"),
	);
	const oldByName = new Map(oldManifest.layers.map((l) => [l.name, l]));
	const patchDir = join(outDir, "patches");
	mkdirSync(patchDir, { recursive: true });

	const patches: PatchInfo[] = [];
	let totalPatchBytes = 0;
	let totalFullBytes = 0;

	for (const newL of newManifest.layers) {
		const oldL = oldByName.get(newL.name);
		totalFullBytes += newL.compressed_size;
		if (!oldL || oldL.hash === newL.hash) {
			if (!oldL) {
				// New layer — must ship full
				patches.push({
					layer: newL.name,
					from_hash: null,
					to_hash: newL.hash,
					full_size: newL.compressed_size,
					patch_size: newL.compressed_size,
					patch_compressed_size: newL.compressed_size,
					method: "full",
					url: newL.url,
				});
				totalPatchBytes += newL.compressed_size;
			} else {
				// Unchanged — no transfer needed
				patches.push({
					layer: newL.name,
					from_hash: oldL.hash,
					to_hash: newL.hash,
					full_size: newL.compressed_size,
					patch_size: 0,
					patch_compressed_size: 0,
					method: "patch",
					url: "",
				});
			}
			continue;
		}

		// Compute uncompressed bsdiff between oldL and newL
		const oldTar = join(oldDir, "layers", `${oldL.hash}.tar`);
		const newTar = join(newDir, "layers", `${newL.hash}.tar`);
		const patchPath = join(patchDir, `${oldL.hash}_to_${newL.hash}.bsdiff`);
		bsdiff(oldTar, newTar, patchPath);
		const patchSize = statSync(patchPath).size;
		// zstd-compress the patch for transport
		const patchZst = patchPath + ".zst";
		zstdCompress(patchPath, patchZst);
		const patchZstSize = statSync(patchZst).size;
		// If patch is bigger than full layer, ship full
		const useFull = patchZstSize >= newL.compressed_size * 0.9;
		patches.push({
			layer: newL.name,
			from_hash: oldL.hash,
			to_hash: newL.hash,
			full_size: newL.compressed_size,
			patch_size: patchSize,
			patch_compressed_size: patchZstSize,
			method: useFull ? "full" : "patch",
			url: useFull ? newL.url : `patches/${basename(patchZst)}`,
		});
		totalPatchBytes += useFull ? newL.compressed_size : patchZstSize;
	}

	return { patches, total_patch_bytes: totalPatchBytes, total_full_bytes: totalFullBytes };
}

// CLI
const args = process.argv.slice(2);
if (args[0] === "build") {
	const [, srcDir, outDir, version] = args;
	if (!srcDir || !outDir) {
		console.error("usage: bun publish.ts build <srcDir> <outDir> [version]");
		process.exit(1);
	}
	const m = buildLayered(srcDir, outDir, version ?? "0.0.0");
	console.log(JSON.stringify(m, null, 2));
} else if (args[0] === "diff") {
	const [, oldDir, newDir, outDir] = args;
	if (!oldDir || !newDir || !outDir) {
		console.error("usage: bun publish.ts diff <oldDir> <newDir> <outDir>");
		process.exit(1);
	}
	const r = generatePatches(oldDir, newDir, outDir);
	console.log(JSON.stringify(r, null, 2));
} else {
	console.error(
		"usage:\n  bun publish.ts build <srcDir> <outDir> [version]\n  bun publish.ts diff <oldDir> <newDir> <outDir>",
	);
	process.exit(1);
}
