// @carbon/plugins/bluetooth — BLE scan, connect, GATT-notify-subscribe,
// and characteristic write (Windows only for now — see the bluetooth
// plugin's own main.zig header comment). Does NOT cover a one-shot GATT
// read, full service/characteristic enumeration, pairing/bonding UI, or
// any macOS/Linux equivalent.
//
// import { useBluetooth } from "@carbon/plugins/bluetooth";
// const { scanStart, scanStop, connect, subscribe, writeCharacteristic } = useBluetooth();
// scanStart();
// carbon.on("bluetooth.device", ({ address, name, rssi }) => { ... });
// connect("AA:BB:CC:DD:EE:FF");
// carbon.on("bluetooth.connected", ({ address }) => {
//   subscribe(address, serviceUuid, charUuid);
//   carbon.on("bluetooth.notify." + charUuid, (bytes: Uint8Array) => { ... });
// });
// writeCharacteristic(address, serviceUuid, charUuid, new Uint8Array([1]));
//
// Every method here DISPATCHES an operation and returns a boolean for
// whether it was successfully dispatched — never the operation's actual
// outcome, which arrives later via `carbon.on(...)`. See the plugin's own
// header for the full event catalog.

import { useCallback } from "react";
import {
  scanStart as rawScanStart,
  scanStop as rawScanStop,
  connect as rawConnect,
  subscribe as rawSubscribe,
  writeCharacteristic as rawWriteCharacteristic,
} from "carbon:bluetooth";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface UseBluetoothResult {
  scanStart: () => boolean;
  scanStop: () => boolean;
  connect: (address: string) => boolean;
  subscribe: (address: string, serviceUuid: string, characteristicUuid: string) => boolean;
  writeCharacteristic: (
    address: string,
    serviceUuid: string,
    characteristicUuid: string,
    bytes: Uint8Array | number[],
  ) => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("scanStart");
}

export function useBluetooth(): UseBluetoothResult {
  const scanStart = useCallback((): boolean => (pluginReady() ? rawScanStart() : false), []);
  const scanStop = useCallback((): boolean => (pluginReady() ? rawScanStop() : false), []);
  const connect = useCallback((address: string): boolean => (pluginReady() ? rawConnect(address) : false), []);
  const subscribe = useCallback(
    (address: string, serviceUuid: string, characteristicUuid: string): boolean =>
      pluginReady() ? rawSubscribe(address, serviceUuid, characteristicUuid) : false,
    [],
  );
  const writeCharacteristic = useCallback(
    (address: string, serviceUuid: string, characteristicUuid: string, bytes: Uint8Array | number[]): boolean => {
      if (!pluginReady()) return false;
      // The native global is called through the engine's own
      // JSON.stringify — a raw Uint8Array serializes to an object with
      // numeric-string keys there, not an array, so it's converted to a
      // plain number array here (see the plugin's own main.zig header
      // for the full explanation of this asymmetry).
      const asArray = Array.isArray(bytes) ? bytes : Array.from(bytes);
      return rawWriteCharacteristic(address, serviceUuid, characteristicUuid, asArray);
    },
    [],
  );

  return { scanStart, scanStop, connect, subscribe, writeCharacteristic, ready: pluginReady() };
}
