/*
 * carbon-native layered publish + patch tool.
 * Voltframe win ported: 563× smaller patches via bsdiff on uncompressed tars.
 *
 *   bun publish.ts build <srcDir> <outDir> [version]
 *   bun publish.ts diff  <oldDir> <newDir> <outDir>
 *
 * Layer scheme for carbon-native bundles:
 *   runtime  -> carbon-runtime.exe (rarely changes)
 *   ui       -> dist/ui/* (Vite output — code-split bundles)
 *   shell    -> shell.js (transpiled shell.ts)
 *   meta     -> carbon.toml + manifest + Info.plist
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { VENDOR_DIR } from "@carbon/workspace";

// Delta-update tools are vendored in tooling/vendor/ so this CLI is
// self-contained; see that directory's README for provenance and checksums.
// The vendored builds are Windows-only, hence the env overrides — a
// contributor on another platform installs bsdiff/zstd natively and points
// BSDIFF / ZSTD at them.
const BSDIFF = process.env.BSDIFF ?? join(VENDOR_DIR, "bsdiff.exe");
const ZSTD = process.env.ZSTD ?? join(VENDOR_DIR, "zig-zstd.exe");

interface LayerSpec { name: string; matcher: (relPath: string) => boolean; }

const DEFAULT_LAYERS: LayerSpec[] = [
	{ name: "runtime", matcher: (p) => p === "carbon-runtime.exe" || p === "carbon-runtime" },
	{ name: "ui", matcher: (p) => p.startsWith("dist/ui/") || p.startsWith("ui/") },
	{ name: "shell", matcher: (p) => p === "shell.js" || p === "dist/shell.js" },
	{ name: "meta", matcher: () => true },
];

interface FileEntry { relPath: string; absPath: string; size: number; hash: string; }

function sha256File(path: string): string {
	const h = createHash("sha256");
	h.update(readFileSync(path));
	return h.digest("hex");
}

function listFiles(root: string): FileEntry[] {
	const entries: FileEntry[] = [];
	function walk(dir: string) {
		for (const item of readdirSync(dir)) {
			const abs = join(dir, item);
			const st = statSync(abs);
			if (st.isDirectory()) walk(abs);
			else {
				const rel = abs.slice(root.length + 1).replace(/\\/g, "/");
				entries.push({ relPath: rel, absPath: abs, size: st.size, hash: sha256File(abs) });
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

// On Windows, prefer the system bsdtar (C:\Windows\System32\tar.exe) since GNU tar
// in MSYS / Git Bash treats `C:` as a remote host.
const TAR = process.env.CARBON_TAR ?? (process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar");

function makeTar(files: FileEntry[], outPath: string, baseDir: string) {
	const fileList = files.map((f) => f.relPath).join("\n");
	const listFile = outPath + ".filelist";
	writeFileSync(listFile, fileList);
	const r = spawnSync(TAR, ["-cf", outPath, "-C", baseDir, "-T", listFile], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
	unlinkSync(listFile);
}

function zstdCompress(input: string, output: string) {
	const r = spawnSync(ZSTD, ["compress", "-i", input, "-o", output, "--no-timing"], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`zstd compress failed: ${r.stderr}`);
}

function bsdiff(from: string, to: string, patchOut: string) {
	const r = spawnSync(BSDIFF, [from, to, patchOut], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`bsdiff failed: ${r.stderr}`);
}

interface LayerManifest { name: string; hash: string; compressed_size: number; uncompressed_size: number; file_count: number; url: string; }
interface BuildManifest { version: string; createdAt: string; layers: LayerManifest[]; files: { path: string; layer: string; hash: string; size: number }[]; }

function buildLayered(srcDir: string, outDir: string, version: string): BuildManifest {
	mkdirSync(outDir, { recursive: true });
	const layersDir = join(outDir, "layers");
	mkdirSync(layersDir, { recursive: true });

	const files = listFiles(srcDir);
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
		files: files.map((f) => ({ path: f.relPath, layer: classify(f.relPath), hash: f.hash, size: f.size })),
	};

	for (const [name, entries] of groups) {
		const layerTar = join(layersDir, `${name}.tar`);
		const layerZst = join(layersDir, `${name}.tar.zst`);
		makeTar(entries, layerTar, srcDir);
		zstdCompress(layerTar, layerZst);
		const layerHash = sha256File(layerZst);
		const finalPath = join(layersDir, `${layerHash}.tar.zst`);
		copyFileSync(layerZst, finalPath);
		unlinkSync(layerZst);
		const finalTar = join(layersDir, `${layerHash}.tar`);
		copyFileSync(layerTar, finalTar);
		unlinkSync(layerTar);

		manifest.layers.push({
			name,
			hash: layerHash,
			compressed_size: statSync(finalPath).size,
			uncompressed_size: statSync(finalTar).size,
			file_count: entries.length,
			url: `layers/${layerHash}.tar.zst`,
		});
	}

	writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
	return manifest;
}

interface PatchInfo { layer: string; from_hash: string | null; to_hash: string; full_size: number; patch_size: number; patch_compressed_size: number; method: "patch" | "full"; url: string; }

function generatePatches(oldDir: string, newDir: string, outDir: string) {
	const oldManifest: BuildManifest = JSON.parse(readFileSync(join(oldDir, "manifest.json"), "utf8"));
	const newManifest: BuildManifest = JSON.parse(readFileSync(join(newDir, "manifest.json"), "utf8"));
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
				patches.push({ layer: newL.name, from_hash: null, to_hash: newL.hash, full_size: newL.compressed_size, patch_size: newL.compressed_size, patch_compressed_size: newL.compressed_size, method: "full", url: newL.url });
				totalPatchBytes += newL.compressed_size;
			} else {
				patches.push({ layer: newL.name, from_hash: oldL.hash, to_hash: newL.hash, full_size: newL.compressed_size, patch_size: 0, patch_compressed_size: 0, method: "patch", url: "" });
			}
			continue;
		}
		const oldTar = join(oldDir, "layers", `${oldL.hash}.tar`);
		const newTar = join(newDir, "layers", `${newL.hash}.tar`);
		const patchPath = join(patchDir, `${oldL.hash}_to_${newL.hash}.bsdiff`);
		bsdiff(oldTar, newTar, patchPath);
		const patchSize = statSync(patchPath).size;
		const patchZst = patchPath + ".zst";
		zstdCompress(patchPath, patchZst);
		const patchZstSize = statSync(patchZst).size;
		const useFull = patchZstSize >= newL.compressed_size * 0.9;
		patches.push({ layer: newL.name, from_hash: oldL.hash, to_hash: newL.hash, full_size: newL.compressed_size, patch_size: patchSize, patch_compressed_size: patchZstSize, method: useFull ? "full" : "patch", url: useFull ? newL.url : `patches/${basename(patchZst)}` });
		totalPatchBytes += useFull ? newL.compressed_size : patchZstSize;
	}

	return { patches, total_patch_bytes: totalPatchBytes, total_full_bytes: totalFullBytes };
}

const args = process.argv.slice(2);
if (args[0] === "build") {
	const [, srcDir, outDir, version] = args;
	if (!srcDir || !outDir) { console.error("usage: bun publish.ts build <srcDir> <outDir> [version]"); process.exit(1); }
	console.log(JSON.stringify(buildLayered(srcDir, outDir, version ?? "0.0.0"), null, 2));
} else if (args[0] === "diff") {
	const [, oldDir, newDir, outDir] = args;
	if (!oldDir || !newDir || !outDir) { console.error("usage: bun publish.ts diff <oldDir> <newDir> <outDir>"); process.exit(1); }
	console.log(JSON.stringify(generatePatches(oldDir, newDir, outDir), null, 2));
} else {
	console.error("usage:\n  bun publish.ts build <srcDir> <outDir> [version]\n  bun publish.ts diff <oldDir> <newDir> <outDir>");
	process.exit(1);
}
