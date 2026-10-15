use serde::Serialize;
use std::sync::OnceLock;

const GIB: u64 = 1 << 30;
const MIN_LOCAL_MEMORY_BYTES: u64 = 8 * GIB;
const MIN_LOCAL_LOGICAL_CPUS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalTier {
  CloudDefault,
  Qwen,
}

#[derive(Debug)]
pub struct HardwareProfile {
  pub memory_bytes: u64,
  pub logical_cpus: usize,
}

pub fn tier_for(profile: Option<&HardwareProfile>) -> LocalTier {
  let Some(profile) = profile else { return LocalTier::Qwen };
  // Zero means unavailable, not a low-end device. Detection failure must not
  // silently turn a new installation into a cloud-first one.
  if profile.memory_bytes == 0 || profile.logical_cpus == 0 {
    return LocalTier::Qwen;
  }
  if profile.memory_bytes < MIN_LOCAL_MEMORY_BYTES || profile.logical_cpus < MIN_LOCAL_LOGICAL_CPUS {
    return LocalTier::CloudDefault;
  }
  LocalTier::Qwen
}

pub fn local_tier() -> LocalTier {
  static TIER: OnceLock<LocalTier> = OnceLock::new();
  *TIER.get_or_init(|| {
    let mut system = sysinfo::System::new();
    system.refresh_memory_specifics(sysinfo::MemoryRefreshKind::nothing().with_ram());
    system.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
    let profile = HardwareProfile {
      memory_bytes: system.total_memory(),
      logical_cpus: system.cpus().len(),
    };
    let tier = tier_for(Some(&profile));
    log::info!(
      target: "typealoud_lifecycle",
      "hardware:profile memory_bytes={} logical_cpus={} local_tier={tier:?}",
      profile.memory_bytes, profile.logical_cpus,
    );
    tier
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn profile(memory_gib: u64, logical_cpus: usize) -> HardwareProfile {
    HardwareProfile { memory_bytes: memory_gib * GIB, logical_cpus }
  }

  #[test]
  fn low_memory_or_core_count_defaults_to_cloud() {
    for hardware in [profile(7, 8), profile(16, 3)] {
      assert_eq!(tier_for(Some(&hardware)), LocalTier::CloudDefault);
    }
    assert_eq!(tier_for(Some(&profile(8, 4))), LocalTier::Qwen);
    assert_eq!(tier_for(Some(&profile(64, 16))), LocalTier::Qwen);
  }

  #[test]
  fn failed_or_incomplete_detection_never_defaults_to_cloud() {
    assert_eq!(tier_for(None), LocalTier::Qwen);
    for hardware in [profile(0, 8), profile(32, 0), profile(0, 2)] {
      assert_eq!(tier_for(Some(&hardware)), LocalTier::Qwen);
    }
  }

  #[test]
  fn tiers_serialize_as_frontend_identifiers() {
    for (tier, name) in [(LocalTier::CloudDefault, "cloud-default"), (LocalTier::Qwen, "qwen")] {
      assert_eq!(serde_json::to_value(tier).unwrap(), name);
    }
  }
}
