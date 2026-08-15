// canvas-executor.ts — Phase 1.5δ JS-side bridge.
//
// Implements `CommandExecutor` by serializing the DrawCommand[] to JSON
// (with base64-encoded typed-array payloads) and posting to the runtime
// via `__carbon_canvas_execute_commands(canvasId, json)`. The Rust side
// (carbon/runtime/engine/gpu-canvas/src/executor.rs) parses + runs the commands.
//
// Wire-format choice:
//   * Strings of structure: it has to traverse a JS↔Rust boundary that's
//     wired through rquickjs's Function-of-string args. JSON is the
//     simplest path that doesn't require ArrayBuffer marshalling.
//   * Typed-array payloads (positions, normals, indices, transforms,
//     normal matrices) are base64-encoded so they survive JSON round-trip
//     intact. The Rust parser decodes them with a tiny inline base64
//     decoder; no heavy crate is pulled in.
//   * Geometry caching: a typed-array is sent to the runtime ONLY the
//     first time we see a given `geometryId`. Subsequent draws of the
//     same geometry omit the bytes and the runtime hits its cache.

import type {
  CommandExecutor,
  DrawCommand,
  MeshCommand,
  LineCommand,
  PointsCommand,
} from "../../domain/draw-commands.js";

declare const __carbon_canvas_execute_commands:
  | ((id: number, json: string) => void)
  | undefined;

// Small base64 encoder for browser-less environments (rquickjs has no
// `btoa` global). We avoid a Buffer dep by writing it inline. This runs
// per-frame for new geometries; once a geometry is cached, it isn't
// re-encoded.
const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(view: Uint8Array): string {
  let s = "";
  let i = 0;
  const len = view.length;
  // Encode 3 bytes -> 4 chars at a time.
  for (; i + 2 < len; i += 3) {
    const b0 = view[i];
    const b1 = view[i + 1];
    const b2 = view[i + 2];
    s += B64_ALPHABET[b0 >> 2];
    s += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    s += B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    s += B64_ALPHABET[b2 & 0x3f];
  }
  // Tail: 1 or 2 leftover bytes get padded with '='.
  if (i < len) {
    const b0 = view[i];
    if (i + 1 === len) {
      s += B64_ALPHABET[b0 >> 2];
      s += B64_ALPHABET[(b0 & 0x03) << 4];
      s += "==";
    } else {
      const b1 = view[i + 1];
      s += B64_ALPHABET[b0 >> 2];
      s += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
      s += B64_ALPHABET[(b1 & 0x0f) << 2];
      s += "=";
    }
  }
  return s;
}

/** Serialize a Float32Array (or any TypedArray) as base64 of its byte view. */
function tab64(arr: ArrayBufferView | null | undefined): string {
  if (!arr) return "";
  const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  return bytesToBase64(view);
}

/** Build the interleaved 48-byte vertex stream from positions/normals/uvs/colors.
 *
 * Stride matches `docs/PHASE1_5_CONTRACTS.md`:
 *   position: vec3 @  0
 *   normal:   vec3 @ 12
 *   uv:       vec2 @ 24
 *   color:    vec4 @ 32
 *   total: 48 bytes per vertex
 *
 * Missing channels fill with safe defaults: normal=(0,0,1), uv=(0,0),
 * color=(1,1,1,1). The shader's `material.color` then drives the lit color.
 */
function buildInterleaved(
  positions: Float32Array,
  normals: Float32Array | null,
  uvs: Float32Array | null,
  vertexCount: number
): Uint8Array {
  const out = new Uint8Array(vertexCount * 48);
  const f = new Float32Array(out.buffer);
  for (let i = 0; i < vertexCount; i++) {
    const base = i * 12; // 12 floats per vertex
    f[base + 0] = positions[i * 3 + 0];
    f[base + 1] = positions[i * 3 + 1];
    f[base + 2] = positions[i * 3 + 2];
    if (normals) {
      f[base + 3] = normals[i * 3 + 0];
      f[base + 4] = normals[i * 3 + 1];
      f[base + 5] = normals[i * 3 + 2];
    } else {
      f[base + 3] = 0; f[base + 4] = 0; f[base + 5] = 1;
    }
    if (uvs) {
      f[base + 6] = uvs[i * 2 + 0];
      f[base + 7] = uvs[i * 2 + 1];
    } else {
      f[base + 6] = 0; f[base + 7] = 0;
    }
    // Vertex color defaults to white (1,1,1,1). Material color does the work.
    f[base + 8] = 1; f[base + 9] = 1; f[base + 10] = 1; f[base + 11] = 1;
  }
  return out;
}

/**
 * `CanvasSurfaceExecutor` — the production CommandExecutor that talks to
 * Phase 1.5's Rust-side GPU executor via the host-binding
 * `__carbon_canvas_execute_commands`.
 *
 * Geometry caching: a typed-array is sent to the runtime ONLY the first
 * time we see a given `geometryId`. Subsequent draws omit the bytes and
 * the Rust-side cache hit serves them.
 */
export class CanvasSurfaceExecutor implements CommandExecutor {
  private canvasId = -1;
  /** geometryIds we've already pushed to the GPU side. The cache is per
   *  CanvasSurfaceExecutor, so each canvas tracks its own uploads. */
  private uploadedGeometries = new Set<number>();

  /** Set by `Canvas.tsx` once the wgpu surface is ready. Until then,
   *  execute() is a no-op (the renderer still walks the scene; we just
   *  drop the commands). */
  setCanvasId(id: number): void {
    this.canvasId = id;
  }

  execute(commands: DrawCommand[]): void {
    if (this.canvasId < 0) return;
    if (typeof __carbon_canvas_execute_commands !== "function") return;

    const json = this.serializeCommands(commands);
    try {
      __carbon_canvas_execute_commands(this.canvasId, json);
    } catch {
      // Swallow — the Rust side already logs malformed commands; throwing
      // in production would break the rAF loop.
    }
  }

  /** Build the JSON payload sent to the runtime. Public for benchmarks
   *  and tests that want to inspect the wire format. */
  serializeCommands(commands: DrawCommand[]): string {
    const out: any[] = [];
    for (const c of commands) {
      switch (c.type) {
        case "clear":
          out.push({ type: "clear", rgba: c.rgba });
          break;
        case "setCamera": {
          const cam = c.camera;
          out.push({
            type: "setCamera",
            camera: {
              view: tab64(cam.view),
              projection: tab64(cam.projection),
              position: cam.position,
            },
          });
          break;
        }
        case "setLights":
          out.push({ type: "setLights", lights: c.lights });
          break;
        case "mesh":
          out.push(this.serializeMesh(c));
          break;
        case "line":
          out.push(this.serializeLine(c));
          break;
        case "points":
          out.push(this.serializePoints(c));
          break;
      }
    }
    return JSON.stringify(out);
  }

  private serializeMesh(c: MeshCommand): any {
    const indexIsU32 = c.indices instanceof Uint32Array;
    const vertexCount = c.positions.length / 3;
    const payload: any = {
      type: "mesh",
      geometryId: c.geometryId,
      indexIsU32,
      vertexCount,
      indexCount: c.indices.length,
      transform: tab64(c.transform),
      normalMatrix: tab64(c.normalMatrix),
      material: {
        type: c.material.type,
        color: c.material.color,
        opacity: c.material.opacity,
        side: c.material.side,
      },
    };
    if (c.material.type === "standard") {
      payload.material.metalness = c.material.metalness;
      payload.material.roughness = c.material.roughness;
    } else if (c.material.type === "phong") {
      payload.material.shininess = c.material.shininess;
      payload.material.specular = c.material.specular;
    }
    // Only ship vertex/index bytes if this is a new geometryId.
    if (!this.uploadedGeometries.has(c.geometryId)) {
      this.uploadedGeometries.add(c.geometryId);
      const interleaved = buildInterleaved(
        c.positions,
        c.normals,
        c.uvs,
        vertexCount
      );
      payload.verticesB64 = bytesToBase64(interleaved);
      payload.indicesB64 = tab64(c.indices);
    }
    return payload;
  }

  private serializeLine(c: LineCommand): any {
    const indexIsU32 = c.indices instanceof Uint32Array;
    const vertexCount = c.positions.length / 3;
    const payload: any = {
      type: "line",
      geometryId: c.geometryId,
      indexIsU32,
      vertexCount,
      indexCount: c.indices ? c.indices.length : 0,
      transform: tab64(c.transform),
      mode: c.mode,
      color: c.color,
      opacity: c.opacity,
    };
    if (!this.uploadedGeometries.has(c.geometryId)) {
      this.uploadedGeometries.add(c.geometryId);
      const interleaved = buildInterleaved(c.positions, null, null, vertexCount);
      payload.verticesB64 = bytesToBase64(interleaved);
      payload.indicesB64 = c.indices ? tab64(c.indices) : "";
    }
    return payload;
  }

  private serializePoints(c: PointsCommand): any {
    const vertexCount = c.positions.length / 3;
    const payload: any = {
      type: "points",
      geometryId: c.geometryId,
      vertexCount,
      transform: tab64(c.transform),
      color: c.color,
      size: c.size,
      opacity: c.opacity,
    };
    if (!this.uploadedGeometries.has(c.geometryId)) {
      this.uploadedGeometries.add(c.geometryId);
      const interleaved = buildInterleaved(c.positions, null, null, vertexCount);
      payload.verticesB64 = bytesToBase64(interleaved);
    }
    return payload;
  }
}
