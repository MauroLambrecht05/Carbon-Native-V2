/*
 * Extended IPC microbench. Adds:
 *   C  — TCP loopback + length-prefixed binary frames + zero-copy buffers
 *   D  — Bun Worker via SharedArrayBuffer ring buffer (cross-thread, same process)
 *
 * Re-runs A / A2 / B for direct comparison.
 *
 * Usage: bun harness-v2.ts <scenario>   where scenario in { A, A2, B, C, D }
 */

import { spawn } from "bun";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { pack, unpack } from "msgpackr";
import { unlinkSync, existsSync } from "node:fs";

const ROLE = process.env.BENCH_ROLE ?? "parent";
const SCENARIO = process.argv[2] ?? "A";

const KEY = Buffer.alloc(32, 1);
const SIZES: Array<[number, number]> = [
	[64, 2000],
	[1024, 2000],
	[65536, 500],
	[262144, 200],
	[1048576, 50],
];

function pct(s: number[], p: number) {
	const i = Math.min(s.length - 1, Math.floor(s.length * p));
	return s[i]!;
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
	return Buffer.concat([
		d.update(Buffer.from(o.encryptedData, "base64")),
		d.final(),
	]).toString("utf8");
}

// ============== A: WS+JSON+AES ==============
async function scenarioA_server(port: number) {
	Bun.serve({
		port,
		fetch(r, s) { return s.upgrade(r) ? undefined : new Response("no"); },
		websocket: {
			message(ws, msg: string) {
				const clear = aesDecrypt(msg);
				const p = JSON.parse(clear);
				ws.send(aesEncrypt(JSON.stringify({ echo: p.payload, id: p.id })));
			},
		},
	});
}
async function scenarioA_client(port: number) {
	const ws = new WebSocket(`ws://localhost:${port}/`);
	await new Promise<void>((r) => ws.addEventListener("open", () => r()));
	const out: any = { scenario: "A", serial: [] };
	for (const [size, iters] of SIZES) {
		const payload = "x".repeat(size);
		for (let i = 0; i < 20; i++) await new Promise<void>((r) => {
			const h = () => { ws.removeEventListener("message", h as any); r(); };
			ws.addEventListener("message", h as any);
			ws.send(aesEncrypt(JSON.stringify({ payload, id: -1 })));
		});
		const times: number[] = [];
		const t0 = performance.now();
		for (let i = 0; i < iters; i++) {
			const ts = performance.now();
			await new Promise<void>((r) => {
				const h = () => { ws.removeEventListener("message", h as any); r(); };
				ws.addEventListener("message", h as any);
				ws.send(aesEncrypt(JSON.stringify({ payload, id: i })));
			});
			times.push(performance.now() - ts);
		}
		const totalMs = performance.now() - t0;
		out.serial.push({
			sizeBytes: size, iterations: iters, total_ms: +totalMs.toFixed(2),
			throughput_msg_per_s: +((iters * 1000) / totalMs).toFixed(0),
			throughput_MB_per_s: +((iters * size * 1000) / (totalMs * 1024 * 1024)).toFixed(3),
			latency: stats(times),
		});
	}
	ws.close();
	console.log(JSON.stringify(out));
}

// ============== A2: WS+JSON, no crypto ==============
async function scenarioA2_server(port: number) {
	Bun.serve({
		port,
		fetch(r, s) { return s.upgrade(r) ? undefined : new Response("no"); },
		websocket: {
			message(ws, msg: string) {
				const p = JSON.parse(msg);
				ws.send(JSON.stringify({ echo: p.payload, id: p.id }));
			},
		},
	});
}
async function scenarioA2_client(port: number) {
	const ws = new WebSocket(`ws://localhost:${port}/`);
	await new Promise<void>((r) => ws.addEventListener("open", () => r()));
	const out: any = { scenario: "A2", serial: [] };
	for (const [size, iters] of SIZES) {
		const payload = "x".repeat(size);
		for (let i = 0; i < 20; i++) await new Promise<void>((r) => {
			const h = () => { ws.removeEventListener("message", h as any); r(); };
			ws.addEventListener("message", h as any);
			ws.send(JSON.stringify({ payload, id: -1 }));
		});
		const times: number[] = [];
		const t0 = performance.now();
		for (let i = 0; i < iters; i++) {
			const ts = performance.now();
			await new Promise<void>((r) => {
				const h = () => { ws.removeEventListener("message", h as any); r(); };
				ws.addEventListener("message", h as any);
				ws.send(JSON.stringify({ payload, id: i }));
			});
			times.push(performance.now() - ts);
		}
		const totalMs = performance.now() - t0;
		out.serial.push({
			sizeBytes: size, iterations: iters, total_ms: +totalMs.toFixed(2),
			throughput_msg_per_s: +((iters * 1000) / totalMs).toFixed(0),
			throughput_MB_per_s: +((iters * size * 1000) / (totalMs * 1024 * 1024)).toFixed(3),
			latency: stats(times),
		});
	}
	ws.close();
	console.log(JSON.stringify(out));
}

// ============== B: Unix socket + length-prefixed + MessagePack ==============
function scenarioB_server(path: string) {
	if (existsSync(path)) try { unlinkSync(path); } catch {}
	Bun.listen({
		unix: path,
		socket: {
			data(socket, buf: Buffer) {
				// @ts-ignore
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
			open() {}, close() {}, error(_s, e) { console.error("[B-server] err", e); },
		},
	});
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
			open() {}, close() {}, error(_s, e) { console.error("[B-client] err", e); },
		},
	});
	function send(obj: any): Promise<any> {
		return new Promise((r) => {
			pending = r;
			const body = pack(obj);
			const out = Buffer.alloc(4 + body.length);
			out.writeUInt32LE(body.length, 0);
			body.copy(out, 4);
			socket.write(out);
		});
	}
	const out: any = { scenario: "B", serial: [] };
	for (const [size, iters] of SIZES) {
		const payload = "x".repeat(size);
		for (let i = 0; i < 20; i++) await send({ payload, id: -1 });
		const times: number[] = [];
		const t0 = performance.now();
		for (let i = 0; i < iters; i++) {
			const ts = performance.now();
			await send({ payload, id: i });
			times.push(performance.now() - ts);
		}
		const totalMs = performance.now() - t0;
		out.serial.push({
			sizeBytes: size, iterations: iters, total_ms: +totalMs.toFixed(2),
			throughput_msg_per_s: +((iters * 1000) / totalMs).toFixed(0),
			throughput_MB_per_s: +((iters * size * 1000) / (totalMs * 1024 * 1024)).toFixed(3),
			latency: stats(times),
		});
	}
	socket.end();
	console.log(JSON.stringify(out));
}

// ============== C: TCP loopback + raw binary frame, no encoding ==============
// Payload structure:  [u32 LE total_len][u32 LE id][u8 op][rest = body bytes]
// op: 0 = ping, 1 = pong
function scenarioC_server(port: number) {
	Bun.listen({
		port, hostname: "127.0.0.1",
		socket: {
			data(socket, buf: Buffer) {
				// @ts-ignore
				if (!socket.state) socket.state = { buf: Buffer.alloc(0) };
				// @ts-ignore
				const s = socket.state as { buf: Buffer };
				s.buf = Buffer.concat([s.buf, buf]);
				while (s.buf.length >= 4) {
					const total = s.buf.readUInt32LE(0);
					if (s.buf.length < 4 + total) break;
					// Echo: reuse the same frame, flip op to 1
					const frame = Buffer.from(s.buf.subarray(0, 4 + total));
					frame[8] = 1; // op = pong
					s.buf = s.buf.subarray(4 + total);
					socket.write(frame);
				}
			},
			open() {}, close() {}, error(_s, e) { console.error("[C-server] err", e); },
		},
	});
}
async function scenarioC_client(port: number) {
	let pending: (() => void) | null = null;
	let recvBuf = Buffer.alloc(0);
	const socket = await Bun.connect({
		port, hostname: "127.0.0.1",
		socket: {
			data(_s, buf: Buffer) {
				recvBuf = Buffer.concat([recvBuf, buf]);
				while (recvBuf.length >= 4) {
					const total = recvBuf.readUInt32LE(0);
					if (recvBuf.length < 4 + total) break;
					recvBuf = recvBuf.subarray(4 + total);
					const p = pending; pending = null;
					p?.();
				}
			},
			open() {}, close() {}, error(_s, e) { console.error("[C-client] err", e); },
		},
	});
	function sendPing(id: number, body: Buffer): Promise<void> {
		return new Promise((r) => {
			pending = r;
			const total = 5 + body.length;
			const out = Buffer.alloc(4 + total);
			out.writeUInt32LE(total, 0);
			out.writeUInt32LE(id, 4);
			out[8] = 0; // op = ping
			body.copy(out, 9);
			socket.write(out);
		});
	}
	const out: any = { scenario: "C", serial: [] };
	for (const [size, iters] of SIZES) {
		const body = Buffer.alloc(size, 0x78);
		for (let i = 0; i < 20; i++) await sendPing(0, body);
		const times: number[] = [];
		const t0 = performance.now();
		for (let i = 0; i < iters; i++) {
			const ts = performance.now();
			await sendPing(i, body);
			times.push(performance.now() - ts);
		}
		const totalMs = performance.now() - t0;
		out.serial.push({
			sizeBytes: size, iterations: iters, total_ms: +totalMs.toFixed(2),
			throughput_msg_per_s: +((iters * 1000) / totalMs).toFixed(0),
			throughput_MB_per_s: +((iters * size * 1000) / (totalMs * 1024 * 1024)).toFixed(3),
			latency: stats(times),
		});
	}
	socket.end();
	console.log(JSON.stringify(out));
}

// ============== D: Worker via SharedArrayBuffer ring buffer ==============
// Cross-thread (not cross-process), but represents the latency floor for shared-mem IPC.
// Producer writes [u32 len][u32 id][bytes]; consumer reads, echoes back via a second ring.
async function scenarioD_run() {
	const RING_SIZE = 4 * 1024 * 1024; // 4 MB ring per direction

	// Layout per ring: 64 bytes of header + ring
	//  [0..4]  head index (writer-owned, atomic)
	//  [4..8]  tail index (reader-owned, atomic)
	//  [8..12] notify counter (atomic, .notify wakes reader)
	//  [12..ring_end]  data area
	const HEADER = 64;
	const DATA = RING_SIZE - HEADER;

	const tx = new SharedArrayBuffer(RING_SIZE);
	const rx = new SharedArrayBuffer(RING_SIZE);

	const workerSrc = `
import { parentPort } from 'node:worker_threads';
const { tx, rx } = await new Promise(r => parentPort.once('message', r));

const T_HEAD = new Int32Array(tx, 0, 1);
const T_TAIL = new Int32Array(tx, 4, 1);
const T_NOTIFY = new Int32Array(tx, 8, 1);
const T_DATA = new Uint8Array(tx, 64);
const R_HEAD = new Int32Array(rx, 0, 1);
const R_TAIL = new Int32Array(rx, 4, 1);
const R_NOTIFY = new Int32Array(rx, 8, 1);
const R_DATA = new Uint8Array(rx, 64);
const DATA_SIZE = T_DATA.length;

const view = new DataView(tx);

while (true) {
  // Wait for new data on tx
  Atomics.wait(T_NOTIFY, 0, Atomics.load(T_NOTIFY, 0));
  while (true) {
    const head = Atomics.load(T_HEAD, 0);
    const tail = Atomics.load(T_TAIL, 0);
    if (head === tail) break;
    // Read [u32 len][u32 id][len bytes]
    const lenOff = tail % DATA_SIZE;
    const len = (T_DATA[lenOff] | (T_DATA[(lenOff+1)%DATA_SIZE]<<8) | (T_DATA[(lenOff+2)%DATA_SIZE]<<16) | (T_DATA[(lenOff+3)%DATA_SIZE]<<24)) >>> 0;
    const idOff = (tail + 4) % DATA_SIZE;
    const id = (T_DATA[idOff] | (T_DATA[(idOff+1)%DATA_SIZE]<<8) | (T_DATA[(idOff+2)%DATA_SIZE]<<16) | (T_DATA[(idOff+3)%DATA_SIZE]<<24)) >>> 0;
    const total = 8 + len;
    Atomics.store(T_TAIL, 0, tail + total);

    // Write back to rx: just len + id + 0 bytes (the echo)
    const rh = Atomics.load(R_HEAD, 0);
    const rOff = rh % DATA_SIZE;
    R_DATA[rOff] = len & 0xff;
    R_DATA[(rOff+1)%DATA_SIZE] = (len>>8) & 0xff;
    R_DATA[(rOff+2)%DATA_SIZE] = (len>>16) & 0xff;
    R_DATA[(rOff+3)%DATA_SIZE] = (len>>24) & 0xff;
    R_DATA[(rOff+4)%DATA_SIZE] = id & 0xff;
    R_DATA[(rOff+5)%DATA_SIZE] = (id>>8) & 0xff;
    R_DATA[(rOff+6)%DATA_SIZE] = (id>>16) & 0xff;
    R_DATA[(rOff+7)%DATA_SIZE] = (id>>24) & 0xff;
    Atomics.store(R_HEAD, 0, rh + 8);
    Atomics.add(R_NOTIFY, 0, 1);
    Atomics.notify(R_NOTIFY, 0);
  }
}
`;

	const blob = new Blob([workerSrc], { type: "application/typescript" });
	const url = URL.createObjectURL(blob);
	// Spawn a worker
	const worker = new Worker(url, { type: "module" } as any);
	worker.postMessage({ tx, rx });

	const T_HEAD = new Int32Array(tx, 0, 1);
	const T_TAIL = new Int32Array(tx, 4, 1);
	const T_NOTIFY = new Int32Array(tx, 8, 1);
	const T_DATA = new Uint8Array(tx, 64);
	const R_HEAD = new Int32Array(rx, 0, 1);
	const R_TAIL = new Int32Array(rx, 4, 1);
	const R_NOTIFY = new Int32Array(rx, 8, 1);
	const R_DATA = new Uint8Array(rx, 64);
	const DATA_SIZE = T_DATA.length;

	// Helper: send body (Uint8Array) and await echo (just header)
	function send(id: number, body: Uint8Array): Promise<void> {
		return new Promise((resolve) => {
			const head = Atomics.load(T_HEAD, 0);
			const off = head % DATA_SIZE;
			const len = body.length;
			T_DATA[off] = len & 0xff;
			T_DATA[(off + 1) % DATA_SIZE] = (len >> 8) & 0xff;
			T_DATA[(off + 2) % DATA_SIZE] = (len >> 16) & 0xff;
			T_DATA[(off + 3) % DATA_SIZE] = (len >> 24) & 0xff;
			T_DATA[(off + 4) % DATA_SIZE] = id & 0xff;
			T_DATA[(off + 5) % DATA_SIZE] = (id >> 8) & 0xff;
			T_DATA[(off + 6) % DATA_SIZE] = (id >> 16) & 0xff;
			T_DATA[(off + 7) % DATA_SIZE] = (id >> 24) & 0xff;
			for (let i = 0; i < len; i++) {
				T_DATA[(off + 8 + i) % DATA_SIZE] = body[i]!;
			}
			Atomics.store(T_HEAD, 0, head + 8 + len);
			Atomics.add(T_NOTIFY, 0, 1);
			Atomics.notify(T_NOTIFY, 0);

			// Wait for echo: spin then yield
			const expected = Atomics.load(R_TAIL, 0) + 8;
			(function poll() {
				if (Atomics.load(R_HEAD, 0) >= expected) {
					Atomics.store(R_TAIL, 0, expected);
					resolve();
					return;
				}
				queueMicrotask(poll);
			})();
		});
	}

	const out: any = { scenario: "D", serial: [] };
	for (const [size, iters] of SIZES) {
		if (size > 1024 * 1024) continue; // ring is 4 MB; stay safely under
		const body = new Uint8Array(size).fill(0x78);
		for (let i = 0; i < 20; i++) await send(-1, body);
		const times: number[] = [];
		const t0 = performance.now();
		for (let i = 0; i < iters; i++) {
			const ts = performance.now();
			await send(i, body);
			times.push(performance.now() - ts);
		}
		const totalMs = performance.now() - t0;
		out.serial.push({
			sizeBytes: size, iterations: iters, total_ms: +totalMs.toFixed(2),
			throughput_msg_per_s: +((iters * 1000) / totalMs).toFixed(0),
			throughput_MB_per_s: +((iters * size * 1000) / (totalMs * 1024 * 1024)).toFixed(3),
			latency: stats(times),
		});
	}
	worker.terminate();
	console.log(JSON.stringify(out));
}

// ============== orchestration ==============
async function runParent() {
	const portMap: Record<string, number> = { A: 50555, A2: 50556, C: 50557 };
	const sockPath =
		process.platform === "win32"
			? "C:\\Users\\mauro\\AppData\\Local\\Temp\\forkbun-bench.sock"
			: "/tmp/forkbun-bench.sock";

	if (SCENARIO === "A") {
		await scenarioA_server(portMap.A!);
	} else if (SCENARIO === "A2") {
		await scenarioA2_server(portMap.A2!);
	} else if (SCENARIO === "B") {
		scenarioB_server(sockPath);
	} else if (SCENARIO === "C") {
		scenarioC_server(portMap.C!);
	} else if (SCENARIO === "D") {
		// in-process bench, no child
		await scenarioD_run();
		process.exit(0);
	} else {
		console.error("unknown scenario", SCENARIO);
		process.exit(1);
	}

	await new Promise((r) => setTimeout(r, 200));
	const child = spawn({
		cmd: [process.execPath, import.meta.path, SCENARIO],
		env: { ...process.env, BENCH_ROLE: "child" },
		stdout: "pipe", stderr: "inherit",
	});
	const out = await new Response(child.stdout).text();
	const lines = out.trim().split("\n");
	process.stdout.write(lines[lines.length - 1]! + "\n");
	process.exit(0);
}

async function runChild() {
	const portMap: Record<string, number> = { A: 50555, A2: 50556, C: 50557 };
	const sockPath =
		process.platform === "win32"
			? "C:\\Users\\mauro\\AppData\\Local\\Temp\\forkbun-bench.sock"
			: "/tmp/forkbun-bench.sock";

	if (SCENARIO === "A") await scenarioA_client(portMap.A!);
	else if (SCENARIO === "A2") await scenarioA2_client(portMap.A2!);
	else if (SCENARIO === "B") await scenarioB_client(sockPath);
	else if (SCENARIO === "C") await scenarioC_client(portMap.C!);
	else throw new Error("unknown scenario " + SCENARIO);
}

if (ROLE === "child") await runChild();
else await runParent();
