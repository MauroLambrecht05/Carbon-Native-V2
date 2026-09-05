// BLE scan, connect, GATT-notify-subscribe, and characteristic write via
// WinRT's `Windows.Devices.Bluetooth`/`GenericAttributeProfile` — backs
// the `bluetooth_*` ABI trampolines in abi/host_exports.rs (ABI 1.20).
//
// SCAN RUNS ON THE JS THREAD, CONNECT/SUBSCRIBE/WRITE DO NOT: starting/
// stopping `BluetoothLEAdvertisementWatcher` and receiving its `Received`
// event are both synchronous/callback-only, the same "safe on the calling
// thread" shape as sharing.rs's `DataTransferManager`. But
// `BluetoothLEDevice::FromBluetoothAddressAsync`,
// `GetGattServicesForUuidAsync`, `GetCharacteristicsForUuidAsync`,
// `ReadValueAsync`/`WriteValueAsync`, and
// `WriteClientCharacteristicConfigurationDescriptorAsync` are all
// `IAsyncOperation`s — same blocking-`.get()`-with-no-message-pump hazard
// biometrics.rs documents at length, so connect/subscribe/write each spawn
// their own fresh MTA background thread (COINIT_MULTITHREADED, not the
// STA the JS thread runs as), matching biometrics.rs's "rare, not a hot
// path, a new thread per call is simpler than a persistent pool" posture.
// `BluetoothLEDevice`/`GattCharacteristic` are confirmed `Send` by the
// `windows` crate itself (`unsafe impl Send for BluetoothLEDevice` etc. in
// its own source — WinRT runtime classes are agile by platform design,
// unlike raw non-agile COM interfaces), so caching a connected device in a
// process-wide `Mutex` and handing it to a fresh thread per call is sound,
// not an assumption.
//
// GATT VALUE-CHANGED NOTIFICATIONS use the new binary-event pipe
// (`push_plugin_binary_event`) instead of JSON/base64 — this is the
// capability that pipe was built for. The event name is
// `"bluetooth.notify." + characteristic_uuid` (the address is NOT part of
// the name — subscribing to the same characteristic UUID on two different
// connected devices at once isn't distinguishable in v1, a known,
// documented limitation, not an oversight).
//
// V1 SCOPE: scan, connect, subscribe-to-notifications, and write. NOT
// covered: a one-shot GATT read (needs a request-id correlation scheme
// across the async boundary that notify's fire-and-forget shape doesn't —
// a separable, larger piece of work), full service/characteristic
// enumeration/browsing (the app is expected to already know the UUIDs it
// targets, the same "no discovery UI" scoping printing.rs's file-picker
// equivalent doesn't need either), pairing/bonding UI, and any macOS/Linux
// equivalent.
//
// PLATFORM: Windows-only.

use anyhow::{anyhow, Result};

#[cfg(target_os = "windows")]
fn parse_uuid(s: &str) -> Result<windows::core::GUID> {
    let hex: String = s
        .trim()
        .trim_start_matches('{')
        .trim_end_matches('}')
        .chars()
        .filter(|c| *c != '-')
        .collect();
    if hex.len() != 32 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(anyhow!("invalid UUID: {s}"));
    }
    let mut bytes = [0u8; 16];
    for i in 0..16 {
        bytes[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .map_err(|_| anyhow!("invalid UUID: {s}"))?;
    }
    let data1 = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    let data2 = u16::from_be_bytes([bytes[4], bytes[5]]);
    let data3 = u16::from_be_bytes([bytes[6], bytes[7]]);
    let mut data4 = [0u8; 8];
    data4.copy_from_slice(&bytes[8..16]);
    Ok(windows::core::GUID::from_values(data1, data2, data3, data4))
}

#[cfg(target_os = "windows")]
fn parse_address(s: &str) -> Result<u64> {
    let hex: String = s.chars().filter(|c| *c != ':').collect();
    if hex.len() != 12 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(anyhow!("invalid Bluetooth address: {s}"));
    }
    u64::from_str_radix(&hex, 16).map_err(|_| anyhow!("invalid Bluetooth address: {s}"))
}

#[cfg(target_os = "windows")]
fn format_address(addr: u64) -> String {
    let b = addr.to_be_bytes();
    format!(
        "{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
        b[2], b[3], b[4], b[5], b[6], b[7]
    )
}

#[cfg(target_os = "windows")]
fn ensure_mta_initialized() {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

// ── Scan (JS thread) ─────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
thread_local! {
    static SCAN_COM_READY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static WATCHER: std::cell::RefCell<Option<windows::Devices::Bluetooth::Advertisement::BluetoothLEAdvertisementWatcher>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(target_os = "windows")]
pub fn scan_start() -> Result<()> {
    use windows::Devices::Bluetooth::Advertisement::{
        BluetoothLEAdvertisementReceivedEventArgs, BluetoothLEAdvertisementWatcher,
        BluetoothLEScanningMode,
    };
    use windows::Foundation::TypedEventHandler;

    SCAN_COM_READY.with(|ready| {
        if !ready.get() {
            use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            }
            ready.set(true);
        }
    });

    WATCHER.with(|cell| -> Result<()> {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            let watcher = BluetoothLEAdvertisementWatcher::new()
                .map_err(|e| anyhow!("BluetoothLEAdvertisementWatcher::new failed: {e}"))?;
            let _ = watcher.SetScanningMode(BluetoothLEScanningMode::Active);
            watcher
                .Received(&TypedEventHandler::new(
                    move |_sender: &Option<BluetoothLEAdvertisementWatcher>,
                          args: &Option<BluetoothLEAdvertisementReceivedEventArgs>|
                          -> windows::core::Result<()> {
                        let Some(args) = args else { return Ok(()) };
                        let address = args.BluetoothAddress().unwrap_or(0);
                        let rssi = args.RawSignalStrengthInDBm().unwrap_or(0);
                        let name = args
                            .Advertisement()
                            .and_then(|a| a.LocalName())
                            .map(|n| n.to_string_lossy())
                            .unwrap_or_default();
                        let json = format!(
                            "{{\"address\":\"{}\",\"name\":{},\"rssi\":{}}}",
                            format_address(address),
                            if name.is_empty() {
                                "null".to_string()
                            } else {
                                format!("{name:?}")
                            },
                            rssi
                        );
                        crate::host_exports::push_plugin_event(
                            "bluetooth.device".to_string(),
                            json,
                        );
                        Ok(())
                    },
                ))
                .map_err(|e| {
                    anyhow!("BluetoothLEAdvertisementWatcher::Received registration failed: {e}")
                })?;
            *slot = Some(watcher);
        }
        slot.as_ref()
            .expect("just set or already present")
            .Start()
            .map_err(|e| anyhow!("watcher Start failed: {e}"))?;
        Ok(())
    })
}

#[cfg(target_os = "windows")]
pub fn scan_stop() -> Result<()> {
    WATCHER.with(|cell| -> Result<()> {
        if let Some(watcher) = cell.borrow().as_ref() {
            watcher
                .Stop()
                .map_err(|e| anyhow!("watcher Stop failed: {e}"))?;
        }
        Ok(())
    })
}

// ── Connected-device cache (shared across background threads) ───────────

#[cfg(target_os = "windows")]
static DEVICES: std::sync::Mutex<
    Option<std::collections::HashMap<u64, windows::Devices::Bluetooth::BluetoothLEDevice>>,
> = std::sync::Mutex::new(None);

#[cfg(target_os = "windows")]
fn cache_device(addr: u64, device: windows::Devices::Bluetooth::BluetoothLEDevice) {
    let mut guard = DEVICES.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(std::collections::HashMap::new)
        .insert(addr, device);
}

#[cfg(target_os = "windows")]
fn cached_device(addr: u64) -> Option<windows::Devices::Bluetooth::BluetoothLEDevice> {
    let guard = DEVICES.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().and_then(|m| m.get(&addr).cloned())
}

#[cfg(target_os = "windows")]
fn find_characteristic(
    device: &windows::Devices::Bluetooth::BluetoothLEDevice,
    service_uuid: windows::core::GUID,
    char_uuid: windows::core::GUID,
) -> Result<windows::Devices::Bluetooth::GenericAttributeProfile::GattCharacteristic> {
    let services_result = device
        .GetGattServicesForUuidAsync(service_uuid)
        .map_err(|e| anyhow!("GetGattServicesForUuidAsync failed: {e}"))?
        .get()?;
    let services = services_result
        .Services()
        .map_err(|e| anyhow!("Services() failed: {e}"))?;
    if services.Size().unwrap_or(0) == 0 {
        return Err(anyhow!("no matching GATT service found"));
    }
    let service = services
        .GetAt(0)
        .map_err(|e| anyhow!("service GetAt(0) failed: {e}"))?;
    let chars_result = service
        .GetCharacteristicsForUuidAsync(char_uuid)
        .map_err(|e| anyhow!("GetCharacteristicsForUuidAsync failed: {e}"))?
        .get()?;
    let chars = chars_result
        .Characteristics()
        .map_err(|e| anyhow!("Characteristics() failed: {e}"))?;
    if chars.Size().unwrap_or(0) == 0 {
        return Err(anyhow!("no matching GATT characteristic found"));
    }
    chars
        .GetAt(0)
        .map_err(|e| anyhow!("characteristic GetAt(0) failed: {e}"))
}

// ── Connect (background MTA thread) ─────────────────────────────────────

#[cfg(target_os = "windows")]
pub fn connect(address: &str) -> Result<()> {
    use windows::Devices::Bluetooth::BluetoothLEDevice;

    let addr = parse_address(address)?;
    let address = address.to_string();
    std::thread::spawn(move || {
        ensure_mta_initialized();
        let outcome = (|| -> Result<BluetoothLEDevice> {
            let device = BluetoothLEDevice::FromBluetoothAddressAsync(addr)
                .map_err(|e| anyhow!("FromBluetoothAddressAsync failed: {e}"))?
                .get()
                .map_err(|e| anyhow!("connect failed: {e}"))?;
            Ok(device)
        })();
        match outcome {
            Ok(device) => {
                cache_device(addr, device);
                crate::host_exports::push_plugin_event(
                    "bluetooth.connected".to_string(),
                    format!("{{\"address\":\"{address}\"}}"),
                );
            }
            Err(e) => {
                crate::host_exports::push_plugin_event(
                    "bluetooth.connect_error".to_string(),
                    format!(
                        "{{\"address\":\"{address}\",\"error\":{:?}}}",
                        e.to_string()
                    ),
                );
            }
        }
    });
    Ok(())
}

// ── Subscribe to notifications (background MTA thread) ──────────────────

#[cfg(target_os = "windows")]
pub fn subscribe(address: &str, service_uuid: &str, characteristic_uuid: &str) -> Result<()> {
    use windows::Devices::Bluetooth::GenericAttributeProfile::{
        GattCharacteristic, GattClientCharacteristicConfigurationDescriptorValue,
        GattValueChangedEventArgs,
    };
    use windows::Foundation::TypedEventHandler;
    use windows::Security::Cryptography::CryptographicBuffer;

    let addr = parse_address(address)?;
    let svc_uuid = parse_uuid(service_uuid)?;
    let char_uuid = parse_uuid(characteristic_uuid)?;
    let address = address.to_string();
    let char_uuid_str = characteristic_uuid.trim().to_lowercase();

    std::thread::spawn(move || {
        ensure_mta_initialized();
        let outcome = (|| -> Result<()> {
            let device = cached_device(addr)
                .ok_or_else(|| anyhow!("not connected — call connect() first"))?;
            let characteristic = find_characteristic(&device, svc_uuid, char_uuid)?;
            let event_name = format!("bluetooth.notify.{char_uuid_str}");
            characteristic
                .ValueChanged(&TypedEventHandler::new(
                    move |_sender: &Option<GattCharacteristic>,
                          args: &Option<GattValueChangedEventArgs>|
                          -> windows::core::Result<()> {
                        let Some(args) = args else { return Ok(()) };
                        let buffer = args.CharacteristicValue()?;
                        let mut out = windows::core::Array::<u8>::default();
                        CryptographicBuffer::CopyToByteArray(&buffer, &mut out)?;
                        crate::host_exports::push_plugin_binary_event(
                            event_name.clone(),
                            out.as_slice().to_vec(),
                        );
                        Ok(())
                    },
                ))
                .map_err(|e| anyhow!("ValueChanged registration failed: {e}"))?;
            characteristic
                .WriteClientCharacteristicConfigurationDescriptorAsync(
                    GattClientCharacteristicConfigurationDescriptorValue::Notify,
                )
                .map_err(|e| {
                    anyhow!("WriteClientCharacteristicConfigurationDescriptorAsync failed: {e}")
                })?
                .get()
                .map_err(|e| anyhow!("enabling notifications failed: {e}"))?;
            Ok(())
        })();
        match outcome {
            Ok(()) => {
                crate::host_exports::push_plugin_event(
                    "bluetooth.subscribed".to_string(),
                    format!(
                        "{{\"address\":\"{address}\",\"characteristicUuid\":{char_uuid_str:?}}}"
                    ),
                );
            }
            Err(e) => {
                let err = e.to_string();
                crate::host_exports::push_plugin_event(
                    "bluetooth.subscribe_error".to_string(),
                    format!(
                        "{{\"address\":\"{address}\",\"characteristicUuid\":{char_uuid_str:?},\"error\":{err:?}}}"
                    ),
                );
            }
        }
    });
    Ok(())
}

// ── Write characteristic (background MTA thread) ─────────────────────────

#[cfg(target_os = "windows")]
pub fn write_characteristic(
    address: &str,
    service_uuid: &str,
    characteristic_uuid: &str,
    data: Vec<u8>,
) -> Result<()> {
    use windows::Security::Cryptography::CryptographicBuffer;

    let addr = parse_address(address)?;
    let svc_uuid = parse_uuid(service_uuid)?;
    let char_uuid = parse_uuid(characteristic_uuid)?;
    let char_uuid_str = characteristic_uuid.trim().to_lowercase();

    std::thread::spawn(move || {
        ensure_mta_initialized();
        let outcome = (|| -> Result<()> {
            let device = cached_device(addr)
                .ok_or_else(|| anyhow!("not connected — call connect() first"))?;
            let characteristic = find_characteristic(&device, svc_uuid, char_uuid)?;
            let buffer = CryptographicBuffer::CreateFromByteArray(&data)
                .map_err(|e| anyhow!("CreateFromByteArray failed: {e}"))?;
            let status = characteristic
                .WriteValueAsync(&buffer)
                .map_err(|e| anyhow!("WriteValueAsync failed: {e}"))?
                .get()
                .map_err(|e| anyhow!("write failed: {e}"))?;
            use windows::Devices::Bluetooth::GenericAttributeProfile::GattCommunicationStatus;
            if status != GattCommunicationStatus::Success {
                return Err(anyhow!("write returned non-success status"));
            }
            Ok(())
        })();
        let ok = outcome.is_ok();
        crate::host_exports::push_plugin_event(
            "bluetooth.write_result".to_string(),
            format!("{{\"characteristicUuid\":{char_uuid_str:?},\"ok\":{ok}}}"),
        );
    });
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn scan_start() -> Result<()> {
    Err(anyhow!("Bluetooth is not yet implemented on this platform"))
}
#[cfg(not(target_os = "windows"))]
pub fn scan_stop() -> Result<()> {
    Err(anyhow!("Bluetooth is not yet implemented on this platform"))
}
#[cfg(not(target_os = "windows"))]
pub fn connect(_address: &str) -> Result<()> {
    Err(anyhow!("Bluetooth is not yet implemented on this platform"))
}
#[cfg(not(target_os = "windows"))]
pub fn subscribe(_address: &str, _service_uuid: &str, _characteristic_uuid: &str) -> Result<()> {
    Err(anyhow!("Bluetooth is not yet implemented on this platform"))
}
#[cfg(not(target_os = "windows"))]
pub fn write_characteristic(
    _address: &str,
    _service_uuid: &str,
    _characteristic_uuid: &str,
    _data: Vec<u8>,
) -> Result<()> {
    Err(anyhow!("Bluetooth is not yet implemented on this platform"))
}
