// LRU image cache keyed by (canonical_path, mtime, file_size).
//
// Design:
//   - The cache key includes file mtime + size so that replacing a file on
//     disk automatically invalidates the cached entry — no manual flush needed.
//   - Eviction is LRU: when `total_bytes` exceeds `max_bytes` we drop the
//     oldest entries first. "Oldest" = position 0 in the order VecDeque.
//   - The order deque tracks insertion/access order separately from the
//     HashMap so we don't need an external linked-hashmap dep. On every
//     `get` hit we move the key to the back of the deque (youngest).
//   - All pixel data is owned by `Arc<DecodedImage>` so JS-side CarbonImage
//     objects that outlive a cache eviction still hold their data.
//
// Thread-safety:
//   Callers hold an `Arc<Mutex<ImageCache>>` so the lock is coarse-grained
//   but the critical section is only ever the HashMap lookup / insert.
//   Actual image decoding always happens *outside* the lock.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::SystemTime;

use crate::decoder::DecodedImage;

/// Cache key: uniquely identifies a specific version of an on-disk file.
/// Any change to path, modification time, or size yields a different key,
/// so the caller sees a cache miss and re-decodes from disk.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey {
    /// Canonical absolute path (after `canonicalize()`).
    pub path: String,
    /// `SystemTime` serialized as Duration-since-epoch for `Hash + Eq`.
    /// We keep the pair rather than converting to seconds to avoid losing
    /// sub-second precision on file systems that support it (NTFS, ext4).
    mtime_secs: u64,
    mtime_nanos: u32,
    /// File size in bytes. Used as a quick second check — two files at the
    /// same mtime but different size are definitely different content.
    pub size: u64,
}

impl CacheKey {
    /// Build a key directly from components. Used in tests that can't easily
    /// create real filesystem metadata but need specific key values.
    pub fn test_key(path: String, mtime_secs: u64, size: u64) -> Self {
        Self {
            path,
            mtime_secs,
            mtime_nanos: 0,
            size,
        }
    }

    /// Build a key from a canonical path + the file's std::fs::Metadata.
    pub fn from_metadata(path: String, meta: &std::fs::Metadata) -> Self {
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let dur = mtime
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default();
        Self {
            path,
            mtime_secs: dur.as_secs(),
            mtime_nanos: dur.subsec_nanos(),
            size: meta.len(),
        }
    }
}

/// LRU cache capped at `max_bytes` of total RGBA8 pixel data.
///
/// Default cap: 256 MiB — enough for ~170 full-HD images at RGBA8.
/// Apps that need a tighter budget (embedded, CI) pass a smaller value
/// to `ImageCache::new`.
pub struct ImageCache {
    /// The actual decoded images, keyed for O(1) lookup.
    entries: HashMap<CacheKey, Arc<DecodedImage>>,
    /// Tracks access order. Back = most-recently used (youngest).
    /// On cache hit we remove the key from wherever it sits and push it
    /// to the back. O(n) removal, but n is bounded by the number of
    /// cached images, not pixel counts. For typical apps n < 200.
    order: VecDeque<CacheKey>,
    /// Running sum of all `DecodedImage::byte_len()` values currently stored.
    pub total_bytes: usize,
    /// Eviction threshold. `insert` evicts oldest entries until
    /// `total_bytes <= max_bytes` *after* the new entry is in.
    pub max_bytes: usize,
}

/// Default cap: 256 MiB.
const DEFAULT_MAX_BYTES: usize = 256 * 1024 * 1024;

impl ImageCache {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            total_bytes: 0,
            max_bytes,
        }
    }

    /// Create with the default 256 MiB cap.
    pub fn with_default_cap() -> Self {
        Self::new(DEFAULT_MAX_BYTES)
    }

    /// Look up a key. On hit, promotes the entry to MRU position.
    pub fn get(&mut self, key: &CacheKey) -> Option<Arc<DecodedImage>> {
        if self.entries.contains_key(key) {
            // Promote to MRU. Remove from current position, push to back.
            if let Some(pos) = self.order.iter().position(|k| k == key) {
                let k = self.order.remove(pos).unwrap();
                self.order.push_back(k);
            }
            self.entries.get(key).cloned()
        } else {
            None
        }
    }

    /// Insert a decoded image. Evicts old entries if needed to respect the
    /// budget. If the single image itself exceeds `max_bytes` we insert it
    /// anyway and immediately evict down after — caller always gets a valid
    /// result; the cache just holds no more than one oversized image at once.
    pub fn insert(&mut self, key: CacheKey, image: Arc<DecodedImage>) {
        // If already present (race between two async loads of the same
        // file), skip — the existing entry is equally valid.
        if self.entries.contains_key(&key) {
            return;
        }
        let byte_cost = image.byte_len();
        self.total_bytes += byte_cost;
        self.order.push_back(key.clone());
        self.entries.insert(key, image);
        self.evict_to_budget();
    }

    /// Remove the oldest entries until `total_bytes <= max_bytes`.
    fn evict_to_budget(&mut self) {
        while self.total_bytes > self.max_bytes && self.order.len() > 1 {
            // Keep at least 1 entry even if it alone exceeds the budget.
            if let Some(oldest_key) = self.order.pop_front() {
                if let Some(evicted) = self.entries.remove(&oldest_key) {
                    self.total_bytes = self.total_bytes.saturating_sub(evicted.byte_len());
                }
            }
        }
    }

    /// Number of entries currently cached.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decoder::DecodedImage;

    fn make_image(px_count: usize) -> Arc<DecodedImage> {
        Arc::new(DecodedImage {
            width: px_count as u32,
            height: 1,
            bytes: vec![0u8; px_count * 4],
            format: "png",
        })
    }

    fn dummy_key(name: &str, size: u64) -> CacheKey {
        CacheKey {
            path: name.to_string(),
            mtime_secs: 42,
            mtime_nanos: 0,
            size,
        }
    }

    #[test]
    fn basic_insert_and_get() {
        let mut cache = ImageCache::new(1024 * 1024);
        let key = dummy_key("/a.png", 100);
        let img = make_image(10);
        cache.insert(key.clone(), img.clone());
        let got = cache.get(&key).expect("should hit");
        assert_eq!(got.width, 10);
    }

    #[test]
    fn miss_returns_none() {
        let mut cache = ImageCache::new(1024 * 1024);
        assert!(cache.get(&dummy_key("/missing.png", 0)).is_none());
    }

    #[test]
    fn eviction_drops_oldest() {
        // Budget: 4 images of 100px × 4 bytes each = 1600 bytes.
        // When we add a 5th, the first should be evicted.
        let budget = 4 * 100 * 4;
        let mut cache = ImageCache::new(budget);
        let keys: Vec<_> = (0..5)
            .map(|i| dummy_key(&format!("/{i}.png"), i as u64))
            .collect();
        let imgs: Vec<_> = (0..5).map(|_| make_image(100)).collect();

        for (k, img) in keys.iter().zip(imgs.iter()).take(4) {
            cache.insert(k.clone(), img.clone());
        }
        assert_eq!(cache.len(), 4);

        // Insert 5th → evicts the first (oldest).
        cache.insert(keys[4].clone(), imgs[4].clone());
        assert_eq!(cache.len(), 4);
        assert!(cache.get(&keys[0]).is_none(), "oldest evicted");
        assert!(cache.get(&keys[4]).is_some(), "newest present");
    }

    #[test]
    fn lru_promotes_on_get() {
        // Insert A, B. Then access A. Then fill to budget. B should be
        // evicted before A.
        let budget = 2 * 100 * 4;
        let mut cache = ImageCache::new(budget);
        let a = dummy_key("/a.png", 1);
        let b = dummy_key("/b.png", 2);
        let c = dummy_key("/c.png", 3);

        cache.insert(a.clone(), make_image(100));
        cache.insert(b.clone(), make_image(100));
        // Touch A → A is now MRU, B is LRU.
        cache.get(&a);
        // Insert C — should evict B (LRU), not A.
        cache.insert(c.clone(), make_image(100));
        assert!(cache.get(&b).is_none(), "B evicted");
        assert!(cache.get(&a).is_some(), "A promoted, still present");
        assert!(cache.get(&c).is_some(), "C present");
    }

    #[test]
    fn duplicate_insert_is_no_op() {
        let mut cache = ImageCache::new(1024 * 1024);
        let key = dummy_key("/same.png", 42);
        cache.insert(key.clone(), make_image(10));
        let before = cache.total_bytes;
        cache.insert(key.clone(), make_image(10)); // duplicate
        assert_eq!(
            cache.total_bytes, before,
            "duplicate must not inflate total_bytes"
        );
        assert_eq!(cache.len(), 1);
    }
}
