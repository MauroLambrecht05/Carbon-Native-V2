// @carbon/three-fiber / types.ts
//
// JSX intrinsic typings. These augment Solid's JSX namespace so apps
// using `<mesh>`, `<boxGeometry>`, `<meshStandardMaterial>` get
// autocomplete + type-checking.
//
// Reference this file from your project's tsconfig:
//   { "compilerOptions": { "types": ["@carbon/three-fiber/types"] } }

import "solid-js";
import type * as THREE from "three";

// ─── Common prop types ────────────────────────────────────────────────────
export type Vector3Like =
  | THREE.Vector3
  | [number, number, number]
  | number;

export type EulerLike =
  | THREE.Euler
  | [number, number, number]
  | [number, number, number, "XYZ" | "XZY" | "YXZ" | "YZX" | "ZXY" | "ZYX"]
  | number;

export type ColorLike =
  | THREE.Color
  | string
  | number
  | [number, number, number];

// Component-wise sugar: `position-x={...}` etc.
type AxisProps<K extends string> = {
  [P in `${K}-x` | `${K}-y` | `${K}-z`]?: number;
};

interface Object3DProps extends AxisProps<"position">, AxisProps<"scale">, AxisProps<"rotation"> {
  position?: Vector3Like;
  rotation?: EulerLike;
  scale?: Vector3Like;
  visible?: boolean;
  frustumCulled?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  renderOrder?: number;
  name?: string;
  userData?: any;
  ref?: ((obj: any) => void) | { current?: any };
  children?: any;
  args?: any[];
  attach?: string;
}

interface MeshProps extends Object3DProps {
  // No mesh-specific props beyond Object3D — geometry/material are children.
}

interface CameraProps extends Object3DProps {
  near?: number;
  far?: number;
  zoom?: number;
}
interface PerspectiveCameraProps extends CameraProps {
  fov?: number;
  aspect?: number;
}
interface OrthographicCameraProps extends CameraProps {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

interface LightProps extends Object3DProps {
  color?: ColorLike;
  intensity?: number;
}
interface DirectionalLightProps extends LightProps {
  // target follows three's default — point at origin unless overridden.
}
interface PointLightProps extends LightProps {
  distance?: number;
  decay?: number;
}
interface SpotLightProps extends LightProps {
  angle?: number;
  penumbra?: number;
  distance?: number;
  decay?: number;
}
interface HemisphereLightProps extends LightProps {
  groundColor?: ColorLike;
}

// ─── Geometry props ───────────────────────────────────────────────────────
interface GeometryProps {
  args?: any[];
  attach?: string;
  ref?: any;
}

// ─── Material props ───────────────────────────────────────────────────────
interface MaterialProps {
  args?: any[];
  attach?: string;
  ref?: any;
  color?: ColorLike;
  opacity?: number;
  transparent?: boolean;
  side?: number;
  visible?: boolean;
  depthTest?: boolean;
  depthWrite?: boolean;
}
interface MeshBasicMaterialProps extends MaterialProps {
  map?: any;
  wireframe?: boolean;
}
interface MeshStandardMaterialProps extends MaterialProps {
  metalness?: number;
  roughness?: number;
  emissive?: ColorLike;
  emissiveIntensity?: number;
  map?: any;
}
interface MeshPhongMaterialProps extends MaterialProps {
  shininess?: number;
  specular?: ColorLike;
  emissive?: ColorLike;
  map?: any;
}
interface MeshLambertMaterialProps extends MaterialProps {
  emissive?: ColorLike;
  map?: any;
}
interface MeshNormalMaterialProps extends MaterialProps {
  flatShading?: boolean;
  wireframe?: boolean;
}
interface LineBasicMaterialProps extends MaterialProps {
  linewidth?: number;
}
interface PointsMaterialProps extends MaterialProps {
  size?: number;
  sizeAttenuation?: boolean;
  map?: any;
}
interface SpriteMaterialProps extends MaterialProps {
  map?: any;
  rotation?: number;
}

// ─── Module augmentation ──────────────────────────────────────────────────
declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      // Object3D
      group: Object3DProps;
      mesh: MeshProps;
      line: Object3DProps;
      lineSegments: Object3DProps;
      lineLoop: Object3DProps;
      points: Object3DProps;
      sprite: Object3DProps;
      object3D: Object3DProps;
      // primitive — escape hatch for pre-built objects
      primitive: Object3DProps & { object: any };
      // Cameras
      perspectiveCamera: PerspectiveCameraProps;
      orthographicCamera: OrthographicCameraProps;
      // Lights
      ambientLight: LightProps;
      directionalLight: DirectionalLightProps;
      pointLight: PointLightProps;
      spotLight: SpotLightProps;
      hemisphereLight: HemisphereLightProps;
      // Geometries
      boxGeometry: GeometryProps;
      sphereGeometry: GeometryProps;
      planeGeometry: GeometryProps;
      bufferGeometry: GeometryProps;
      cylinderGeometry: GeometryProps;
      coneGeometry: GeometryProps;
      torusGeometry: GeometryProps;
      // Materials
      meshBasicMaterial: MeshBasicMaterialProps;
      meshStandardMaterial: MeshStandardMaterialProps;
      meshPhongMaterial: MeshPhongMaterialProps;
      meshLambertMaterial: MeshLambertMaterialProps;
      meshNormalMaterial: MeshNormalMaterialProps;
      lineBasicMaterial: LineBasicMaterialProps;
      pointsMaterial: PointsMaterialProps;
      spriteMaterial: SpriteMaterialProps;
    }
  }
}

export {};
