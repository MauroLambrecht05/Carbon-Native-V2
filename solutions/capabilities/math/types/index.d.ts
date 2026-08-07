// Type declarations for carbon-fast-math.
//
// We mirror the three.js Vector3/Matrix4/Quaternion/Box3/Frustum/Color API
// surface as TypeScript interfaces so existing user code that imports
// `Vector3` from `'three'` (and is rewritten to `'carbon-fast-math'` by
// the carbon-fast-import Vite plugin) continues to type-check.
//
// We don't extend or import from `three`'s types — vendoring a compatible
// signature keeps this package zero-dep. Coverage is intentionally narrow:
// only the methods our Rust classes implement.

export class Vector3 {
  constructor(x?: number, y?: number, z?: number);
  x: number;
  y: number;
  z: number;
  readonly isVector3: true;

  set(x: number, y: number, z: number): this;
  setScalar(s: number): this;
  setX(x: number): this;
  setY(y: number): this;
  setZ(z: number): this;
  copy(v: Vector3): this;

  add(v: Vector3): this;
  addScalar(s: number): this;
  addVectors(a: Vector3, b: Vector3): this;
  addScaledVector(v: Vector3, s: number): this;

  sub(v: Vector3): this;
  subScalar(s: number): this;
  subVectors(a: Vector3, b: Vector3): this;

  multiply(v: Vector3): this;
  multiplyScalar(s: number): this;
  multiplyVectors(a: Vector3, b: Vector3): this;
  divide(v: Vector3): this;
  divideScalar(s: number): this;
  negate(): this;

  dot(v: Vector3): number;
  lengthSq(): number;
  length(): number;
  manhattanLength(): number;
  normalize(): this;
  setLength(len: number): this;

  cross(v: Vector3): this;
  crossVectors(a: Vector3, b: Vector3): this;
  lerp(v: Vector3, alpha: number): this;
  lerpVectors(a: Vector3, b: Vector3, alpha: number): this;

  applyMatrix4(m: Matrix4): this;
  applyQuaternion(q: Quaternion): this;

  distanceTo(v: Vector3): number;
  distanceToSquared(v: Vector3): number;
  manhattanDistanceTo(v: Vector3): number;

  min(v: Vector3): this;
  max(v: Vector3): this;
  clamp(min: Vector3, max: Vector3): this;
  clampScalar(min: number, max: number): this;

  floor(): this;
  ceil(): this;
  round(): this;

  equals(v: Vector3): boolean;
  clone(): Vector3;
  fromArray(a: ArrayLike<number>, offset?: number): this;
  toArray(): number[];
}

export class Matrix4 {
  constructor();
  readonly isMatrix4: true;
  elements: number[];

  set(
    n11: number, n12: number, n13: number, n14: number,
    n21: number, n22: number, n23: number, n24: number,
    n31: number, n32: number, n33: number, n34: number,
    n41: number, n42: number, n43: number, n44: number,
  ): this;

  identity(): this;
  clone(): Matrix4;
  copy(m: Matrix4): this;

  multiply(m: Matrix4): this;
  premultiply(m: Matrix4): this;
  multiplyMatrices(a: Matrix4, b: Matrix4): this;
  multiplyScalar(s: number): this;

  determinant(): number;
  transpose(): this;
  invert(): this;

  makeTranslation(x: number, y: number, z: number): this;
  makeScale(x: number, y: number, z: number): this;
  makeRotationX(theta: number): this;
  makeRotationY(theta: number): this;
  makeRotationZ(theta: number): this;
  makeRotationFromQuaternion(q: Quaternion): this;
  compose(position: Vector3, quaternion: Quaternion, scale: Vector3): this;
  decompose(position: Vector3, quaternion: Quaternion, scale: Vector3): this;
  makePerspective(left: number, right: number, top: number, bottom: number, near: number, far: number): this;
  makeOrthographic(left: number, right: number, top: number, bottom: number, near: number, far: number): this;
  lookAt(eye: Vector3, target: Vector3, up: Vector3): this;
  equals(m: Matrix4): boolean;
}

export class Quaternion {
  constructor(x?: number, y?: number, z?: number, w?: number);
  x: number;
  y: number;
  z: number;
  w: number;
  readonly isQuaternion: true;

  set(x: number, y: number, z: number, w: number): this;
  copy(q: Quaternion): this;
  clone(): Quaternion;
  identity(): this;

  setFromAxisAngle(axis: Vector3, angle: number): this;
  setFromEuler(euler: { x: number; y: number; z: number; order?: string } | number, y?: number, z?: number, order?: string): this;

  multiply(q: Quaternion): this;
  premultiply(q: Quaternion): this;
  multiplyQuaternions(a: Quaternion, b: Quaternion): this;

  conjugate(): this;
  invert(): this;
  dot(q: Quaternion): number;
  lengthSq(): number;
  length(): number;
  normalize(): this;
  slerp(q: Quaternion, t: number): this;
  equals(q: Quaternion): boolean;
}

export class Box3 {
  constructor(min?: Vector3, max?: Vector3);
  readonly isBox3: true;
  min: Vector3;
  max: Vector3;

  set(min: Vector3, max: Vector3): this;
  makeEmpty(): this;
  isEmpty(): boolean;
  copy(b: Box3): this;
  clone(): Box3;
  expandByPoint(p: Vector3): this;
  expandByScalar(s: number): this;
  expandByVector(v: Vector3): this;
  setFromPoints(points: Vector3[]): this;
  containsPoint(p: Vector3): boolean;
  containsBox(b: Box3): boolean;
  intersectsBox(b: Box3): boolean;
  intersectsSphere(center: Vector3, radius: number): boolean;
  getCenter(target?: Vector3): Vector3;
  getSize(target?: Vector3): Vector3;
  equals(b: Box3): boolean;
}

export class Frustum {
  constructor();
  readonly isFrustum: true;
  setFromProjectionMatrix(m: Matrix4): this;
  intersectsBox(b: Box3): boolean;
  intersectsSphere(center: Vector3, radius: number): boolean;
  containsPoint(p: Vector3): boolean;
  copy(f: Frustum): this;
  clone(): Frustum;
}

export class Color {
  constructor(r?: number | string, g?: number, b?: number);
  r: number;
  g: number;
  b: number;
  readonly isColor: true;

  set(value: number | string | Color): this;
  setHex(hex: number): this;
  setRGB(r: number, g: number, b: number): this;
  setHSL(h: number, s: number, l: number): this;
  getHex(): number;
  getHexString(): string;
  copy(c: Color): this;
  clone(): Color;
  lerp(c: Color, alpha: number): this;
  lerpColors(a: Color, b: Color, t: number): this;
  multiply(c: Color): this;
  multiplyScalar(s: number): this;
  add(c: Color): this;
  equals(c: Color): boolean;
}

declare const _default: {
  Vector3: typeof Vector3;
  Matrix4: typeof Matrix4;
  Quaternion: typeof Quaternion;
  Box3: typeof Box3;
  Frustum: typeof Frustum;
  Color: typeof Color;
};
export default _default;
