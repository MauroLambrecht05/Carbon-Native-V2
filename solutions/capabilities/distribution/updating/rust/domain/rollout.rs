use sha2::{Digest, Sha256};

pub fn in_rollout(installation_id: &str, version: &str, rollout_pct: u8) -> bool {
    if rollout_pct >= 100 {
        return true;
    }

    if rollout_pct == 0 {
        return false;
    }

    let input = format!("{}{}", installation_id, version);
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let hash = hasher.finalize();

    let bucket = u32::from_be_bytes([hash[0], hash[1], hash[2], hash[3]]) % 100;
    bucket < rollout_pct as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rollout_100_percent() {
        assert!(in_rollout("install-123", "1.0.0", 100));
        assert!(in_rollout("install-456", "1.0.1", 100));
    }

    #[test]
    fn test_rollout_0_percent() {
        assert!(!in_rollout("install-123", "1.0.0", 0));
        assert!(!in_rollout("install-456", "1.0.1", 0));
    }

    #[test]
    fn test_rollout_consistency() {
        let result1 = in_rollout("install-123", "1.0.0", 50);
        let result2 = in_rollout("install-123", "1.0.0", 50);
        assert_eq!(result1, result2);
    }

    /// The property that actually matters: the hash spreads installations
    /// across the bucket space, so a percentage gate admits roughly that
    /// percentage of them.
    ///
    /// This replaces a test that asserted two specific installation IDs landed
    /// on *opposite* sides of a 50% rollout. For a uniform hash that is a coin
    /// flip, so it passed or failed depending on which two strings were
    /// hardcoded — it was asserting a property the function does not have and
    /// should not have.
    #[test]
    fn test_rollout_distributes_across_installations() {
        for pct in [10u8, 25, 50, 75, 90] {
            let admitted = (0..2000)
                .filter(|i| in_rollout(&format!("install-{i}"), "1.0.0", pct))
                .count();
            let actual = admitted as f64 / 2000.0 * 100.0;
            let delta = (actual - pct as f64).abs();
            assert!(
                delta < 5.0,
                "rollout at {pct}% admitted {actual:.1}% of 2000 installations \
                 (drift {delta:.1}pp, tolerance 5pp)"
            );
        }
    }

    /// A given installation's bucket must not shift between versions in a way
    /// that lets it re-enter a rollout it was already excluded from — but
    /// different versions must re-shuffle, so a machine unlucky once is not
    /// unlucky forever.
    #[test]
    fn test_rollout_reshuffles_per_version() {
        let differs = (0..500)
            .filter(|i| {
                let id = format!("install-{i}");
                in_rollout(&id, "1.0.0", 50) != in_rollout(&id, "2.0.0", 50)
            })
            .count();
        assert!(
            differs > 100,
            "only {differs}/500 installations changed bucket between versions; \
             the version is not contributing to the hash"
        );
    }
}
