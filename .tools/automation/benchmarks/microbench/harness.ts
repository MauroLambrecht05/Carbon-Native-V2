/*
 * Apples-to-apples IPC harness.
 * Same hardware, same Bun version, same message payloads, same iterations.
 *   A = current Electrobun style: WebSocket over TCP localhost + JSON + AES-256-GCM per message
 *   B = proposed rewrite style:   Bun Unix-domain socket + length-prefixed framing + MessagePack + session token once
 *
 * Run: bun harness.ts <scenario>   where scenario in { A, B }
 * Parent starts a server, spawns a child that is the client; child reports JSON stats to stdout.
 */

import { spawn } from "bun";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { pack, unpack } from "msgpackr";
import { unlinkSync, existsSync } from "node:fs";

const ROLE = process.env.BENCH_ROLE ?? "parent";
const SCENARIO = process.argv[2] ?? "A";

const KEY = Buffer.alloc(32, 1); // fixed for reproducibility; in real system it's per-session
const SIZES: Array<[number, number]> = [
	[64, 2000],
	[1024, 2000],
	[65536, 500],
	[262144, 200],
	[1048576, 50],
];

function pct(sorted: number[], p: number) {
	const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
	return sorted[i]!;
}
function stats(times: number[]) {
	const s = [...times].sort((a, b) => a - b);
	const n = s.length;
	const sum = s.reduce((a, b) => a + b, 0);
	const mean = sum / n;
	return {
		n,
		mean_ms: +mean.toFixed(4),
		min_ms: +s[0]!.toFixed(4),
		p50_ms: +pct(s, 0.5).toFixed(4),
		p95_ms: +pct(s, 0.95).toFixed(4),
		p99_ms: +pct(s, 0.99).toFixed(4),
		max_ms: +s[n - 1]!.toFixed(4),
		stddev_ms: +Math.sqrt(
			s.reduce((a, t) => a + (t - mean) ** 2, 0) / n,
		).toFixed(4),
	};
}

function aesEncrypt(plain: string) {
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", KEY, iv);
	const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
	const tag = c.getAuthTag();
	return JSON.stringify({
		encryptedData: ct.toString("base64"),
		iv: iv.toString("base64"),
		tag: tag.toString("base64"),
	});
}
function aesDecrypt(wire: string) {
	const o = JSON.parse(wire);
	const d = createDecipheriv("aes-256-gcm", KEY, Buffer.from(o.iv, "base64"));
	d.setAuthTag(Buffer.from(o.tag, "base64"));
	const pt = Buffer.concat([
		d.update(Buffer.from(o.encryptedData, "base64")),
		d.final(),
	]);
	return pt.toString("utf8");
}

// ========== SCENARIO A: WebSocket + JSON + AES ==========
async function scenarioA_server(port: number) {
	Bun.serve({
		port,
		fetch(req, server) {
			if (server.upgrade(req)) return;
			return new Response("no");
		},
		websocket: {
			message(ws, msg: string) {
				const clear = aesDecrypt(msg);
				const parsed = JSON.parse(clear);
				const reply = JSON.stringify({ echo: parsed.payload, id: parsed.id });
				ws.send(aesEncrypt(reply));
			},
		},
	});
	console.error(`[A-server] listening on ws://localhost:${port}`);
}

async function scenarioA_client(port: number) {
	const ws = new WebSocket(`ws://localhost:${port}/`);
	await new Promise<void>((res, rej) => {
		ws.addEventListener("open", () => res());
		ws.addEventListener("error", (e) => rej(e));
	});
	const results: any = { scenario: "A", serial: [] };
	for (const [size, iters] of SIZES) {
		const payload = "x".repeat(size);
		// warmup
		for (let i = 0; i < 20; i++) {
			await new Promise<void>((res) => {
				const h = (ev: MessageEvent) => {
					ws.removeEventListener("message", h as any);
					res();
				};
				ws.addEventListener("message", h as any);
				ws.send(aesEncrypt(JSON.stringify({ payload, id: -1 })));
			});
		}
		const times: number[] = [];
		const totalStart = performance.now();
		for (let i = 0; i < iters; i++) {
			const t0 = performance.now();
			await new Promise<void>((res) => {
				const h = (ev: MessageEvent) => {
					ws.removeEventListener("message", h as any);
					res();
				};
				ws.addEventListener("message", h as any);
				ws.send(aesEncrypt(JSON.stringify({ payload, id: i })));
			});
			times.push(performance.now() - t0);
		}
		const totalMs = performance.now() - totalStart;
		results.serial.push({
			sizeBytes: size,
			iterations: iters,
			total_ms: +totalMs.toFixed(2),
			throughput_msg_per_s: +((iters * 1000) / totalMs).toFixed(0),
			throughput_MB_per_s: +(
				(iters * size * 1000) /
				(totalMs * 1024 * 1024)
			).toFixed(3),
			latency: stats(times),
		});
	}
	ws.close();
	console.log(JSON.stringify(results));
}

// ========== SCENARIO A2: WebSocket + JSON, NO crypto (isolates AES cost) ==========
async function scenarioA2_server(port: number) {
	Bun.serve({
		port,
		fetch(req, server) {
			if (server.upgrade(req)) return;
			return new Response("no");
		},
		websocket: {
			message(ws, msg: string) {
				const parsed = JSON.parse(msg);
				ws.send(JSON.stringify({ echo: parsed.payload, id: parsed.id }));
			},
		},
	});
}
async function scenarioA2_client(port: number) {
	const ws = new WebSocket(`ws://localhost:${port}/`);
	await new Promise<void>((res) => ws.addEventListener("open", () => res()));
	const results: any = { scenario: "A2", serial: [] };
	for (const [size, iters] of SIZES) {
		const payload = "x".repeat(size);
		for (let i = 0; i < 20; i++) {
			await new Promise<void>((res) => {
				const h = () => { ws.removeEventListener("message", h as any); res(); };
				ws.addEventListener("message", h as any);
				ws.send(JSON.stringify({ payload, id: -1 }));
			});
		}
		const times: number[] = [];
		const totalStart = performance.now();
		for (let i = 0; i < iters; i++) {
			const t0 = performance.now();
			await new Promise<void>((res) => {
				const h = () => { ws.removeEventListener("message", h as any); res(); };
				ws.addEventListener("message", h as any);
				ws.send(JSON.stringify({ payload, id: i }));
			});
			times.push(performance.now() - t0);
		}
		const totalMs = performance.now() - totalStart;
		results.serial.push({
			sizeBytes: size,
			iterations: iters,
			total_ms: +totalMs.toFixed(2),
			throughput_msg_per_s: +((iters * 1000) / totalMs).toFixed(0),
			throughput_MB_per_s: +((iters * size * 1000) / (totalMs * 1024 * 1024)).toFixed(3),
			latency: stats(times),
		});
	}
	ws.close();
	console.log(JSON.stringify(results));
}

// ========== SCENARIO B: Unix socket + length-prefixed + MessagePack, no crypto ==========
function scenarioB_server(path: string) {
	if (existsSync(path)) try { unlinkSync(path); } catch {}
	Bun.listen({
		unix: path,
		socket: {
			data(socket, buf: Buffer) {
				// Parse length-prefixed frames. Stateful buffer per connection.
				// @ts-ignore attach state
				if (!socket.state) socket.state = { buf: Buffer.alloc(0) };
				// @ts-ignore
				const s = socket.state as { buf: Buffer };
				s.buf = Buffer.concat([s.buf, buf]);
				while (s.buf.length >= 4) {
					const len = s.buf.readUInt32LE(0);
					if (s.buf.length < 4 + len) break;
					const payload = s.buf.subarray(4, 4 + len);
					s.buf = s.buf.subarray(4 + len);
					const msg = unpack(payload) as { payload: string; id: number };
					const reply = pack({ echo: msg.payload, id: msg.id });
					const out = Buffer.alloc(4 + reply.length);
					out.writeUInt32LE(reply.length, 0);
					reply.copy(out, 4);
					socket.write(out);
				}
			},
			open() {},
			close() {},
			error(_s, e) {
				console.error("[B-server] err", e);
			},
		},
	});
	console.error(`[B-server] listening on unix ${path}`);
}

async function scenarioB_client(path: string) {
	let pending: ((m: any) => void) | null = null;
	let recvBuf = Buffer.alloc(0);
	const socket = await Bun.connect({
		unix: path,
		socket: {
			data(_s, buf: Buffer) {
				recvBuf = Buffer.concat([recvBuf, buf]);
				while (recvBuf.length >= 4) {
					const len = recvBuf.readUInt32LE(0);
					if (recvBuf.length < 4 + len) break;
					const payload = recvBuf.subarray(4, 4 + len);
					recvBuf = recvBuf.subarray(4 + len);
					const msg = unpack(payload);
					const p = pending; pending = null;
					p?.(msg);
				}
			},
			open() {},
			close() {},
			error(_s, e) { console.error("[B-client] err", e); },
		},
	});

	function send(obj: any): Promise<any> {
		return new Promise((resolve) => {
			pending = resolve;
			const body = pack(obj);
			const out = Buffer.alloc(4 + body.length);
			out.writeUInt32LE(body.length, 0);
			body.copy(out, 4);
			socket.write(out);
		});
	}

	const results: any = { scenario: "B", serial: [] };
	for (const [size, iters] of SIZES) {
		const payload = "x".repeat(size);
		for (let i = 0; i < 20; i++) await send({ payload, id: -1 });
		const times: number[] = [];
		const totalStart = performance.now();
		for (let i = 0; i < iters; i++) {
			const t0 = performance.now();
			await send({ payload, id: i });
			times.push(performance.now() - t0);
		}
		const totalMs = performance.now() - totalStart;
		results.serial.push({
			sizeBytes: size,
			iterations: iters,
			total_ms: +totalMs.toFixed(2),
			throughput_msg_per_s: +((iters * 1000) / totalMs).toFixed(0),
			throughput_MB_per_s: +(
				(iters * size * 1000) /
				(totalMs * 1024 * 1024)
			).toFixed(3),
			latency: stats(times),
		});
	}
	socket.end();
	console.log(JSON.stringify(results));
}

// ========== orchestration ==========
async function runParent() {
	const scenario = SCENARIO;
	if (scenario === "A") {
		const port = 50555;
		await scenarioA_server(port);
		await new Promise((r) => setTimeout(r, 200));
		const child = spawn({
			cmd: [process.execPath, import.meta.path, "A"],
			env: { ...process.env, BENCH_ROLE: "child" },
			stdout: "pipe",
			stderr: "inherit",
		});
		const out = await new Response(child.stdout).text();
		const lines = out.trim().split("\n");
		const last = lines[lines.length - 1]!;
		process.stdout.write(last + "\n");
		process.exit(0);
	} else if (scenario === "A2") {
		const port = 50556;
		await scenarioA2_server(port);
		await new Promise((r) => setTimeout(r, 200));
		const child = spawn({
			cmd: [process.execPath, import.meta.path, "A2"],
			env: { ...process.env, BENCH_ROLE: "child" },
			stdout: "pipe",
			stderr: "inherit",
		});
		const out = await new Response(child.stdout).text();
		const lines = out.trim().split("\n");
		process.stdout.write(lines[lines.length - 1]! + "\n");
		process.exit(0);
	} else if (scenario === "B") {
		// AF_UNIX on Windows requires a filesystem path not starting with \\.\pipe
		const sockPath =
			process.platform === "win32"
				? "C:\\Users\\mauro\\AppData\\Local\\Temp\\electrobun-bench.sock"
				: "/tmp/electrobun-bench.sock";
		scenarioB_server(sockPath);
		await new Promise((r) => setTimeout(r, 200));
		const child = spawn({
			cmd: [process.execPath, import.meta.path, "B"],
			env: { ...process.env, BENCH_ROLE: "child" },
			stdout: "pipe",
			stderr: "inherit",
		});
		const out = await new Response(child.stdout).text();
		const lines = out.trim().split("\n");
		const last = lines[lines.length - 1]!;
		process.stdout.write(last + "\n");
		process.exit(0);
	}
}

async function runChild() {
	if (SCENARIO === "A") {
		await scenarioA_client(50555);
	} else if (SCENARIO === "A2") {
		await scenarioA2_client(50556);
	} else {
		const sockPath =
			process.platform === "win32"
				? "C:\\Users\\mauro\\AppData\\Local\\Temp\\electrobun-bench.sock"
				: "/tmp/electrobun-bench.sock";
		await scenarioB_client(sockPath);
	}
}

if (ROLE === "child") await runChild();
else await runParent();
