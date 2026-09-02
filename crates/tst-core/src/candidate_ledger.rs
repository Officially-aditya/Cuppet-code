use crate::memory::{normalize_key, EvidenceKind, MemoryKind, Provenance};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

const LEDGER_SCHEMA_VERSION: u32 = 1;
const DEFAULT_MAX_ENTRIES: usize = 512;
const MAX_SOURCE_REFS: usize = 8;
const MAX_IDENTITY_REFS: usize = 16;
const MAX_CLAIM_BYTES: usize = 600;
const MAX_SOURCE_REF_BYTES: usize = 500;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CandidateSignal {
    Support,
    Correction,
    Contradiction,
    DownstreamVerification,
}

#[derive(Clone, Debug)]
pub struct CandidateObservation {
    /// Canonicalized claim text. A model may normalize this text, but the
    /// provenance below must continue to describe the author of the evidence.
    pub claim: String,
    pub kind: MemoryKind,
    pub provenance: Provenance,
    pub signal: CandidateSignal,
    pub session_id: String,
    pub project_id: Option<String>,
    pub source_ref: String,
    pub timestamp_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CandidateLedgerEntry {
    pub claim: String,
    pub kind: MemoryKind,
    pub support_count: u32,
    pub explicit_user_count: u32,
    pub correction_count: u32,
    pub session_count: u32,
    pub project_count: u32,
    pub contradiction_count: u32,
    pub downstream_verification_count: u32,
    pub last_seen: u64,
    #[serde(default)]
    pub source_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    session_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    project_refs: Vec<String>,
}

impl CandidateLedgerEntry {
    pub fn has_independent_reinforcement(&self) -> bool {
        self.session_count >= 2 || self.project_count >= 2 || self.correction_count > 0
    }

    pub fn supports_user_preference(&self) -> bool {
        self.kind == MemoryKind::Preference && self.explicit_user_count > 0
    }

    /// Produces only ledger-owned evidence. Structural and behavioral verifier
    /// evidence must still come from their existing trusted verification paths.
    pub fn promotion_evidence(&self) -> Vec<EvidenceKind> {
        let mut evidence = Vec::with_capacity(2);
        if self.supports_user_preference() {
            evidence.push(EvidenceKind::UserPreference);
        }
        if self.has_independent_reinforcement() {
            evidence.push(EvidenceKind::IndependentReinforcement);
        }
        evidence
    }

    /// Deterministic admission score intended to feed, not replace,
    /// `MemoryRecord::is_promotable()`.
    ///
    /// A single model candidate remains at the normal 0.5 candidate score.
    /// Explicit user evidence is strong enough for preferences, while repeated
    /// independent support can lift other candidate kinds to the existing 0.8
    /// threshold. Any unresolved contradiction caps the ledger contribution
    /// below that threshold.
    pub fn admission_score(&self, now_ms: u64) -> f32 {
        let mut score = 0.5_f32;
        if self.explicit_user_count > 0 {
            score = 1.0;
        } else {
            if self.session_count >= 2 {
                score += 0.2;
            }
            if self.project_count >= 2 {
                score += 0.1;
            }
            if self.support_count >= 3 {
                score += 0.1;
            }
            if self.correction_count > 0 {
                score += 0.2;
            }
            if self.downstream_verification_count > 0 {
                score += 0.2;
            }
        }

        if self.contradiction_count > 0 {
            score = score.min(0.79);
            score -= (self.contradiction_count.saturating_sub(1) as f32 * 0.1).min(0.29);
        }

        // Old, weak ledger candidates fade without changing their auditable
        // counters. Strong evidence remains available until normal compaction.
        let age_days = now_ms.saturating_sub(self.last_seen) as f32 / 86_400_000.0;
        if age_days > 30.0
            && self.explicit_user_count == 0
            && self.downstream_verification_count == 0
            && !self.has_independent_reinforcement()
        {
            score *= 0.98_f32.powf(age_days - 30.0);
        }
        score.clamp(0.0, 1.0)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CandidateLedger {
    version: u32,
    max_entries: usize,
    entries: BTreeMap<String, CandidateLedgerEntry>,
}

impl Default for CandidateLedger {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_ENTRIES)
    }
}

impl CandidateLedger {
    pub fn new(max_entries: usize) -> Self {
        Self {
            version: LEDGER_SCHEMA_VERSION,
            max_entries: max_entries.max(1),
            entries: BTreeMap::new(),
        }
    }

    pub fn open(path: impl AsRef<Path>, max_entries: usize) -> Result<Self> {
        let path = path.as_ref();
        if !path.exists() {
            return Ok(Self::new(max_entries));
        }
        let bytes = fs::read(path)
            .with_context(|| format!("failed to read candidate ledger {}", path.display()))?;
        let mut ledger: Self = serde_json::from_slice(&bytes)
            .with_context(|| format!("failed to decode candidate ledger {}", path.display()))?;
        if ledger.version != LEDGER_SCHEMA_VERSION {
            return Ok(Self::new(max_entries));
        }
        ledger.max_entries = max_entries.max(1);
        ledger.enforce_bound();
        Ok(ledger)
    }

    pub fn persist(&self, path: impl AsRef<Path>) -> Result<()> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create candidate ledger dir {}", parent.display()))?;
        }
        let bytes = serde_json::to_vec(self).context("failed to encode candidate ledger")?;
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, bytes)
            .with_context(|| format!("failed to write candidate ledger {}", tmp.display()))?;
        fs::rename(&tmp, path)
            .with_context(|| format!("failed to replace candidate ledger {}", path.display()))?;
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, claim: &str, kind: &MemoryKind) -> Option<&CandidateLedgerEntry> {
        self.entries.get(&ledger_key(claim, kind))
    }

    pub fn observe(&mut self, observation: CandidateObservation) -> &CandidateLedgerEntry {
        let claim = bounded_text(&observation.claim, MAX_CLAIM_BYTES);
        let key = ledger_key(&claim, &observation.kind);
        let session_ref = identity_hash(&observation.session_id);
        let project_ref = observation.project_id.as_deref().map(identity_hash);
        let source_ref = bounded_text(&observation.source_ref, MAX_SOURCE_REF_BYTES);

        let entry = self.entries.entry(key.clone()).or_insert_with(|| CandidateLedgerEntry {
            claim: claim.clone(),
            kind: observation.kind.clone(),
            support_count: 0,
            explicit_user_count: 0,
            correction_count: 0,
            session_count: 0,
            project_count: 0,
            contradiction_count: 0,
            downstream_verification_count: 0,
            last_seen: observation.timestamp_ms,
            source_refs: Vec::new(),
            session_refs: Vec::new(),
            project_refs: Vec::new(),
        });

        entry.claim = claim;
        entry.last_seen = entry.last_seen.max(observation.timestamp_ms);
        match observation.signal {
            CandidateSignal::Support => {
                entry.support_count = entry.support_count.saturating_add(1);
            }
            CandidateSignal::Correction => {
                entry.support_count = entry.support_count.saturating_add(1);
                entry.correction_count = entry.correction_count.saturating_add(1);
            }
            CandidateSignal::Contradiction => {
                entry.contradiction_count = entry.contradiction_count.saturating_add(1);
            }
            CandidateSignal::DownstreamVerification => {
                entry.support_count = entry.support_count.saturating_add(1);
                entry.downstream_verification_count =
                    entry.downstream_verification_count.saturating_add(1);
            }
        }
        if observation.provenance == Provenance::ExplicitUser
            && observation.signal != CandidateSignal::Contradiction
        {
            entry.explicit_user_count = entry.explicit_user_count.saturating_add(1);
        }
        push_unique_bounded(&mut entry.session_refs, session_ref, MAX_IDENTITY_REFS);
        entry.session_count = entry.session_refs.len() as u32;
        if let Some(project_ref) = project_ref {
            push_unique_bounded(&mut entry.project_refs, project_ref, MAX_IDENTITY_REFS);
            entry.project_count = entry.project_refs.len() as u32;
        }
        if !source_ref.is_empty() {
            push_unique_bounded(&mut entry.source_refs, source_ref, MAX_SOURCE_REFS);
        }

        self.enforce_bound();
        // The just-observed entry can only be evicted when max_entries is zero,
        // which `new` prevents. Stronger/older entries may win ties, so recover
        // it defensively if a future ranking policy changes.
        self.entries.get(&key).expect("observed ledger entry retained")
    }

    /// Drops stale weak noise while retaining explicit, corrected, verified,
    /// or independently reinforced claims. Returns the number removed.
    pub fn decay(&mut self, now_ms: u64, weak_ttl_ms: u64) -> usize {
        let before = self.entries.len();
        self.entries.retain(|_, entry| {
            let weak = entry.explicit_user_count == 0
                && entry.correction_count == 0
                && entry.downstream_verification_count == 0
                && !entry.has_independent_reinforcement();
            !weak || now_ms.saturating_sub(entry.last_seen) <= weak_ttl_ms
        });
        before - self.entries.len()
    }

    pub fn compact(&mut self) -> usize {
        let before = self.entries.len();
        self.enforce_bound();
        before - self.entries.len()
    }

    fn enforce_bound(&mut self) {
        while self.entries.len() > self.max_entries {
            let victim = self
                .entries
                .iter()
                .min_by(|(_, left), (_, right)| retention_cmp(left, right))
                .map(|(key, _)| key.clone());
            let Some(victim) = victim else { break };
            self.entries.remove(&victim);
        }
    }
}

fn ledger_key(claim: &str, kind: &MemoryKind) -> String {
    format!("{kind:?}:{}", normalize_key(claim))
}

fn retention_cmp(left: &CandidateLedgerEntry, right: &CandidateLedgerEntry) -> Ordering {
    retention_strength(left)
        .cmp(&retention_strength(right))
        .then_with(|| left.last_seen.cmp(&right.last_seen))
        .then_with(|| normalize_key(&left.claim).cmp(&normalize_key(&right.claim)))
}

fn retention_strength(entry: &CandidateLedgerEntry) -> u64 {
    u64::from(entry.explicit_user_count) * 100
        + u64::from(entry.downstream_verification_count) * 50
        + u64::from(entry.correction_count) * 30
        + u64::from(entry.session_count.saturating_sub(1)) * 20
        + u64::from(entry.project_count.saturating_sub(1)) * 20
        + u64::from(entry.support_count)
        - u64::from(entry.contradiction_count).min(u64::from(entry.support_count))
}

fn identity_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    hex::encode(&digest[..8])
}

fn push_unique_bounded(values: &mut Vec<String>, value: String, max: usize) {
    if values.iter().any(|item| item == &value) {
        return;
    }
    values.push(value);
    if values.len() > max {
        values.drain(0..values.len() - max);
    }
}

fn bounded_text(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.trim().to_string();
    }
    let mut end = max_bytes.min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn observation(
        claim: &str,
        provenance: Provenance,
        signal: CandidateSignal,
        session_id: &str,
        timestamp_ms: u64,
    ) -> CandidateObservation {
        CandidateObservation {
            claim: claim.into(),
            kind: MemoryKind::Preference,
            provenance,
            signal,
            session_id: session_id.into(),
            project_id: Some("project-a".into()),
            source_ref: format!("turn:{session_id}"),
            timestamp_ms,
        }
    }

    #[test]
    fn explicit_user_preference_keeps_user_provenance_after_canonicalization() {
        let mut ledger = CandidateLedger::default();
        let entry = ledger.observe(observation(
            "Prefer concise status updates",
            Provenance::ExplicitUser,
            CandidateSignal::Support,
            "s1",
            10,
        ));

        assert_eq!(entry.explicit_user_count, 1);
        assert!(entry.supports_user_preference());
        assert_eq!(entry.promotion_evidence(), vec![EvidenceKind::UserPreference]);
        assert_eq!(entry.admission_score(10), 1.0);
    }

    #[test]
    fn canonical_equivalents_merge_and_reinforce_across_sessions() {
        let mut ledger = CandidateLedger::default();
        ledger.observe(observation(
            "Prefer concise status updates",
            Provenance::ModelCandidate,
            CandidateSignal::Support,
            "s1",
            10,
        ));
        let entry = ledger.observe(observation(
            "  prefer   concise STATUS updates  ",
            Provenance::ModelCandidate,
            CandidateSignal::Support,
            "s2",
            20,
        ));

        assert_eq!(ledger.len(), 1);
        assert_eq!(entry.support_count, 2);
        assert_eq!(entry.session_count, 2);
        assert!(entry.has_independent_reinforcement());
        assert!(entry.promotion_evidence().contains(&EvidenceKind::IndependentReinforcement));
    }

    #[test]
    fn one_off_model_candidate_stays_below_promotion_threshold() {
        let mut ledger = CandidateLedger::default();
        let entry = ledger.observe(observation(
            "Use a repository pattern",
            Provenance::ModelCandidate,
            CandidateSignal::Support,
            "s1",
            10,
        ));

        assert_eq!(entry.admission_score(10), 0.5);
        assert!(entry.promotion_evidence().is_empty());
    }

    #[test]
    fn corrections_accumulate_as_strong_reinforcement() {
        let mut ledger = CandidateLedger::default();
        ledger.observe(observation(
            "Prefer tabs",
            Provenance::ModelCandidate,
            CandidateSignal::Support,
            "s1",
            10,
        ));
        let entry = ledger.observe(observation(
            "Prefer tabs",
            Provenance::ExplicitUser,
            CandidateSignal::Correction,
            "s1",
            20,
        ));

        assert_eq!(entry.support_count, 2);
        assert_eq!(entry.correction_count, 1);
        assert_eq!(entry.explicit_user_count, 1);
        assert!(entry.has_independent_reinforcement());
    }

    #[test]
    fn unresolved_contradiction_blocks_ledger_admission() {
        let mut ledger = CandidateLedger::default();
        ledger.observe(observation(
            "Prefer tabs",
            Provenance::ExplicitUser,
            CandidateSignal::Support,
            "s1",
            10,
        ));
        let entry = ledger.observe(observation(
            "Prefer tabs",
            Provenance::ExplicitUser,
            CandidateSignal::Contradiction,
            "s2",
            20,
        ));

        assert_eq!(entry.contradiction_count, 1);
        assert!(entry.admission_score(20) < 0.8);
    }

    #[test]
    fn bounded_ledger_prefers_stronger_entries() {
        let mut ledger = CandidateLedger::new(2);
        ledger.observe(observation(
            "Keep me",
            Provenance::ExplicitUser,
            CandidateSignal::Support,
            "s1",
            1,
        ));
        ledger.observe(observation(
            "weak old",
            Provenance::ModelCandidate,
            CandidateSignal::Support,
            "s2",
            2,
        ));
        ledger.observe(observation(
            "weak new",
            Provenance::ModelCandidate,
            CandidateSignal::Support,
            "s3",
            3,
        ));

        assert_eq!(ledger.len(), 2);
        assert!(ledger.get("Keep me", &MemoryKind::Preference).is_some());
        assert!(ledger.get("weak old", &MemoryKind::Preference).is_none());
    }

    #[test]
    fn persisted_ledger_reinforces_across_process_sessions() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("candidate-ledger.json");
        let mut ledger = CandidateLedger::default();
        ledger.observe(observation(
            "Prefer concise status updates",
            Provenance::ModelCandidate,
            CandidateSignal::Support,
            "s1",
            10,
        ));
        ledger.persist(&path).unwrap();

        let mut reopened = CandidateLedger::open(&path, DEFAULT_MAX_ENTRIES).unwrap();
        let entry = reopened.observe(observation(
            "Prefer concise status updates",
            Provenance::ModelCandidate,
            CandidateSignal::Support,
            "s2",
            20,
        ));

        assert_eq!(entry.session_count, 2);
        assert!(entry.has_independent_reinforcement());
    }

    #[test]
    fn decay_removes_only_old_weak_noise() {
        let mut ledger = CandidateLedger::default();
        ledger.observe(observation(
            "weak",
            Provenance::ModelCandidate,
            CandidateSignal::Support,
            "s1",
            1,
        ));
        ledger.observe(observation(
            "strong",
            Provenance::ExplicitUser,
            CandidateSignal::Support,
            "s2",
            1,
        ));

        assert_eq!(ledger.decay(1_001, 100), 1);
        assert!(ledger.get("weak", &MemoryKind::Preference).is_none());
        assert!(ledger.get("strong", &MemoryKind::Preference).is_some());
    }
}
