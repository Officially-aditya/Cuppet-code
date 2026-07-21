use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    TokenStatistics,
    ConceptAnchor,
    StructurePattern,
    BehavioralClaim,
    Preference,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    Session,
    Project,
    Global,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Provenance {
    ExplicitUser,
    Verifier,
    ModelCandidate,
    Tool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    UserPreference,
    AstHash,
    ContentHash,
    CommandSuccess,
    IndependentReinforcement,
    SecondaryModel,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Evidence {
    pub kind: EvidenceKind,
    pub reference: String,
    pub success: bool,
    pub timestamp_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub id: String,
    pub key: String,
    pub normalized_key: String,
    pub value: String,
    pub kind: MemoryKind,
    pub scope: MemoryScope,
    pub provenance: Provenance,
    pub score: f32,
    pub pinned: bool,
    pub verified: bool,
    pub stale: bool,
    pub tombstone: bool,
    pub created_ms: u64,
    pub updated_ms: u64,
    pub access_count: u64,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    #[serde(default)]
    pub file_hashes: BTreeMap<String, String>,
}

impl MemoryRecord {
    pub fn is_promotable(&self) -> bool {
        if self.score < 0.8 || self.stale || self.tombstone {
            return false;
        }

        let valid = self
            .evidence
            .iter()
            .filter(|item| item.success && item.kind != EvidenceKind::SecondaryModel);

        match self.kind {
            MemoryKind::Preference => valid
                .clone()
                .any(|item| item.kind == EvidenceKind::UserPreference),
            MemoryKind::StructurePattern => valid.clone().any(|item| {
                matches!(item.kind, EvidenceKind::AstHash | EvidenceKind::ContentHash)
                    && item.content_hash.is_some()
            }),
            MemoryKind::BehavioralClaim => valid
                .clone()
                .any(|item| item.kind == EvidenceKind::CommandSuccess),
            MemoryKind::TokenStatistics | MemoryKind::ConceptAnchor => valid.count() > 0,
        }
    }
}

pub fn normalize_key(value: &str) -> String {
    value
        .split_whitespace()
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}
