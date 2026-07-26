use crate::graph::{
    CodeGraph, GraphFileList, GraphLocateResult, GraphQueryResult, GraphSearchResult, GraphStats,
    GraphTraceResult, GraphTraceSummary, GraphWorkspaceInfo,
};
use crate::memory::{
    normalize_key, Evidence, EvidenceKind, MemoryKind, MemoryRecord, MemoryScope, Provenance,
};
use crate::persistence::{DurableStore, StoreStats};
use crate::stm::ShortTermMemory;
use crate::PROTOCOL_VERSION;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const STM_CAPACITY: usize = 256;
const DECAY_BETA: f32 = 0.98;

#[derive(Clone, Debug, Deserialize)]
pub struct ObserveInput {
    pub session_id: String,
    pub key: String,
    pub value: String,
    #[serde(default = "default_kind")]
    pub kind: MemoryKind,
    #[serde(default = "default_scope")]
    pub scope: MemoryScope,
    #[serde(default = "default_provenance")]
    pub provenance: Provenance,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub file_hashes: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct QueryInput {
    pub session_id: String,
    pub query: String,
    #[serde(default = "default_query_limit")]
    pub limit: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct QueryOutput {
    pub stm: Vec<MemoryRecord>,
    pub ltm: Vec<MemoryRecord>,
    pub graph: Vec<GraphQueryResult>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RememberInput {
    pub session_id: String,
    pub key: String,
    pub value: String,
    #[serde(default = "default_kind_preference")]
    pub kind: MemoryKind,
    #[serde(default = "default_scope_project")]
    pub scope: MemoryScope,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub file_hashes: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct EvidenceInput {
    pub session_id: String,
    pub memory_id: String,
    pub kind: EvidenceKind,
    pub reference: String,
    pub success: bool,
    #[serde(default)]
    pub content_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub protocol: &'static str,
    pub sessions: usize,
    pub stm_entries: usize,
    pub project: StoreStats,
    pub global: StoreStats,
    pub graph: GraphStats,
    pub recovery_warnings: Vec<String>,
}

pub struct TstService {
    sessions: HashMap<String, ShortTermMemory>,
    project: DurableStore,
    global: DurableStore,
    graph: CodeGraph,
    project_store: std::path::PathBuf,
}

impl TstService {
    pub fn open(
        project_root: impl AsRef<Path>,
        project_store: impl AsRef<Path>,
        global_store: impl AsRef<Path>,
    ) -> Result<Self> {
        let project_store = project_store.as_ref().to_path_buf();
        let project = DurableStore::open(&project_store)?;
        let global = DurableStore::open(global_store)?;
        let mut graph = CodeGraph::new(project_root)?;
        let _ = graph.load_snapshot(&project_store.join("graph.msgpack"));
        Ok(Self {
            sessions: HashMap::new(),
            project,
            global,
            graph,
            project_store,
        })
    }

    pub fn observe(&mut self, input: ObserveInput) -> Result<String> {
        if is_sensitive_candidate(&input.key, &input.value) {
            return Err(anyhow!("candidate rejected by secret-bearing memory policy"));
        }
        let now = now_ms();
        let score = match input.provenance {
            Provenance::ExplicitUser => 1.0,
            Provenance::Verifier => 0.9,
            Provenance::ModelCandidate | Provenance::Tool => 0.5,
        };
        let id = memory_id(&input.session_id, &input.scope, &input.key);
        let evidence = if input.provenance == Provenance::ExplicitUser && input.kind == MemoryKind::Preference
        {
            vec![Evidence {
                kind: EvidenceKind::UserPreference,
                reference: "explicit user instruction".into(),
                success: true,
                timestamp_ms: now,
                content_hash: None,
            }]
        } else {
            Vec::new()
        };
        let record = MemoryRecord {
            id: id.clone(),
            key: input.key,
            normalized_key: String::new(),
            value: input.value,
            kind: input.kind,
            scope: input.scope,
            provenance: input.provenance,
            score,
            pinned: input.pinned,
            verified: false,
            stale: false,
            tombstone: false,
            created_ms: now,
            updated_ms: now,
            access_count: 0,
            evidence,
            file_hashes: input.file_hashes,
        };
        self.session(&input.session_id).upsert(record)?;
        self.promote_eligible(&input.session_id)?;
        Ok(id)
    }

    pub fn remember(&mut self, input: RememberInput) -> Result<String> {
        let id = self.observe(ObserveInput {
            session_id: input.session_id.clone(),
            key: input.key,
            value: input.value,
            kind: input.kind,
            scope: input.scope,
            provenance: Provenance::ExplicitUser,
            pinned: input.pinned,
            file_hashes: input.file_hashes,
        })?;
        self.promote_eligible(&input.session_id)?;
        Ok(id)
    }

    pub fn record_evidence(&mut self, input: EvidenceInput) -> Result<bool> {
        let now = now_ms();
        let structural_evidence_valid =
            if matches!(input.kind, EvidenceKind::AstHash | EvidenceKind::ContentHash) {
                let Some(record) = self
                    .sessions
                    .get(&input.session_id)
                    .and_then(|stm| stm.entries().find(|record| record.id == input.memory_id))
                else {
                    return Ok(false);
                };
                input.content_hash.as_ref().is_some_and(|content_hash| {
                    !record.file_hashes.is_empty()
                        && record.file_hashes.iter().any(|(path, expected)| {
                            expected == content_hash
                                && self
                                    .graph
                                    .content_hash(path)
                                    .is_some_and(|current| current == content_hash)
                        })
                })
            } else {
                true
            };
        let Some(stm) = self.sessions.get_mut(&input.session_id) else {
            return Ok(false);
        };
        let Some(record) = stm.entries_mut().find(|record| record.id == input.memory_id) else {
            return Ok(false);
        };
        let success = input.success && structural_evidence_valid;
        if success && input.kind != EvidenceKind::SecondaryModel {
            record.score = (record.score + 0.1).min(1.0);
        }
        record.evidence.push(Evidence {
            kind: input.kind,
            reference: input.reference,
            success,
            timestamp_ms: now,
            content_hash: input.content_hash,
        });
        record.updated_ms = now;
        self.promote_eligible(&input.session_id)?;
        Ok(true)
    }

    pub fn query(&mut self, input: QueryInput) -> QueryOutput {
        let limit = input.limit.clamp(1, 128);
        let stm_limit = (limit / 5).max(1);
        let ltm_limit = ((limit * 3) / 10).max(1);
        let graph_limit = limit.saturating_sub(stm_limit + ltm_limit).max(1);
        let stm = self.session(&input.session_id).query(&input.query, stm_limit);
        let mut ltm = self.project.query(&input.query, ltm_limit);
        if ltm.len() < ltm_limit {
            ltm.extend(self.global.query(&input.query, ltm_limit - ltm.len()));
        }
        let graph = self.graph.query(&input.query, graph_limit);
        QueryOutput { stm, ltm, graph }
    }

    pub fn forget(&mut self, session_id: &str, key: &str) -> Result<usize> {
        let mut removed = usize::from(
            self.sessions
                .get_mut(session_id)
                .is_some_and(|stm| stm.remove(key)),
        );
        if let Some(record) = self.project.exact(key) {
            removed += usize::from(self.project.tombstone(&record.id, now_ms())?);
        }
        if let Some(record) = self.global.exact(key) {
            removed += usize::from(self.global.tombstone(&record.id, now_ms())?);
        }
        Ok(removed)
    }

    pub fn clear(&mut self, session_id: &str, scope: MemoryScope) -> Result<usize> {
        match scope {
            MemoryScope::Session => {
                let removed = self.sessions.remove(session_id).map_or(0, |stm| stm.len());
                Ok(removed)
            }
            MemoryScope::Project => tombstone_scope(&mut self.project, MemoryScope::Project),
            MemoryScope::Global => tombstone_scope(&mut self.global, MemoryScope::Global),
        }
    }

    pub fn completed_foreground_turn(&mut self, session_id: &str) -> Result<usize> {
        if let Some(stm) = self.sessions.get_mut(session_id) {
            stm.decay(DECAY_BETA);
        }
        self.promote_eligible(session_id)
    }

    pub fn invalidate_file(&mut self, relative_path: &str, current_hash: &str) -> Result<usize> {
        let project = self.project.invalidate_path(relative_path, current_hash)?;
        let global = self.global.invalidate_path(relative_path, current_hash)?;
        Ok(project + global)
    }

    pub fn update_graph_path(&mut self, path: &Path) -> Result<Option<String>> {
        let graph_path = canonical_graph_path(path);
        if graph_path.file_name().is_some_and(|name| name == ".gitignore") {
            let previous = self.graph.file_hashes();
            self.graph.build()?;
            for (path, _) in previous {
                if self.graph.content_hash(&path).is_none() {
                    self.invalidate_file(&path, "")?;
                }
            }
            return Ok(None);
        }
        let relative = graph_path
            .strip_prefix(self.graph.root())
            .ok()
            .map(|path| path.to_string_lossy().replace('\\', "/"));
        if graph_path.exists() {
            let hash = self.graph.index_file(&graph_path)?;
            if let Some(hash) = &hash {
                if let Some(relative) = &relative {
                    self.invalidate_file(relative, hash)?;
                }
            } else {
                self.graph.remove_file(&graph_path)?;
                if let Some(relative) = &relative {
                    self.invalidate_file(relative, "")?;
                }
            }
            Ok(hash)
        } else {
            self.graph.remove_file(&graph_path)?;
            if let Some(relative) = &relative {
                self.invalidate_file(relative, "")?;
            }
            Ok(None)
        }
    }

    pub fn begin_graph_index(&mut self) -> Vec<std::path::PathBuf> {
        self.graph.begin_build()
    }

    pub fn index_graph_path(&mut self, path: &Path) {
        self.graph.index_build_path(path);
    }

    pub fn finish_graph_index(&mut self) {
        self.graph.finish_build();
        let _ = self
            .graph
            .save_snapshot(&self.project_store.join("graph.msgpack"));
    }

    pub fn graph_query(&self, query: &str, limit: usize) -> Vec<GraphQueryResult> {
        self.graph.query(query, limit.clamp(1, 128))
    }

    pub fn graph_search(&self, pattern: &str, prefix: Option<&str>, limit: usize) -> GraphSearchResult {
        self.graph.search(pattern, prefix, limit)
    }

    pub fn graph_locate(&self, pattern: &str, prefix: Option<&str>, limit: usize) -> GraphLocateResult {
        self.graph.locate(pattern, prefix, limit)
    }

    pub fn graph_list(&self, prefix: Option<&str>, limit: usize) -> GraphFileList {
        self.graph.list_files(prefix, limit)
    }

    pub fn graph_workspace(&self, limit: usize) -> GraphWorkspaceInfo {
        self.graph.workspace_info(limit)
    }

    pub fn graph_trace(
        &self,
        query: &str,
        direction: &str,
        depth: usize,
        limit: usize,
    ) -> Result<GraphTraceResult> {
        self.graph.trace(query, direction, depth, limit)
    }

    pub fn graph_trace_summary(
        &self,
        query: &str,
        direction: &str,
        depth: usize,
        limit: usize,
    ) -> Result<GraphTraceSummary> {
        self.graph.trace_summary(query, direction, depth, limit)
    }

    pub fn compact(&mut self) -> Result<()> {
        let session_ids: Vec<String> = self.sessions.keys().cloned().collect();
        for session_id in session_ids {
            self.promote_eligible(&session_id)?;
        }
        self.project.compact()?;
        self.global.compact()?;
        let _ = self
            .graph
            .save_snapshot(&self.project_store.join("graph.msgpack"));
        Ok(())
    }

    pub fn flush(&mut self) -> Result<()> {
        self.project.flush()?;
        self.global.flush()?;
        let _ = self
            .graph
            .save_snapshot(&self.project_store.join("graph.msgpack"));
        Ok(())
    }

    pub fn status(&self) -> Status {
        let mut recovery_warnings = self.project.recovery().warnings.clone();
        recovery_warnings.extend(self.global.recovery().warnings.clone());
        Status {
            protocol: PROTOCOL_VERSION,
            sessions: self.sessions.len(),
            stm_entries: self.sessions.values().map(ShortTermMemory::len).sum(),
            project: self.project.stats(),
            global: self.global.stats(),
            graph: self.graph.stats(),
            recovery_warnings,
        }
    }

    fn session(&mut self, session_id: &str) -> &mut ShortTermMemory {
        self.sessions
            .entry(session_id.into())
            .or_insert_with(|| ShortTermMemory::new(session_id, STM_CAPACITY))
    }

    fn promote_eligible(&mut self, session_id: &str) -> Result<usize> {
        let Some(stm) = self.sessions.get_mut(session_id) else {
            return Ok(0);
        };
        let mut eligible = Vec::new();
        for record in stm.entries_mut() {
            if !record.verified && record.is_promotable() {
                record.verified = true;
                record.updated_ms = now_ms();
                eligible.push(record.clone());
            }
        }
        for record in &eligible {
            match record.scope {
                MemoryScope::Global => self.global.upsert(record.clone())?,
                MemoryScope::Project | MemoryScope::Session => self.project.upsert(record.clone())?,
            }
        }
        Ok(eligible.len())
    }
}

fn tombstone_scope(store: &mut DurableStore, scope: MemoryScope) -> Result<usize> {
    let ids: Vec<String> = store
        .records()
        .filter(|record| record.scope == scope && !record.tombstone)
        .map(|record| record.id.clone())
        .collect();
    let now = now_ms();
    for id in &ids {
        store.tombstone(id, now)?;
    }
    Ok(ids.len())
}

fn default_kind() -> MemoryKind {
    MemoryKind::ConceptAnchor
}

fn default_kind_preference() -> MemoryKind {
    MemoryKind::Preference
}

fn default_scope() -> MemoryScope {
    MemoryScope::Session
}

fn default_scope_project() -> MemoryScope {
    MemoryScope::Project
}

fn default_provenance() -> Provenance {
    Provenance::ModelCandidate
}

fn default_query_limit() -> usize {
    20
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn canonical_graph_path(path: &Path) -> std::path::PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| {
        path.parent()
            .and_then(|parent| fs::canonicalize(parent).ok())
            .and_then(|parent| path.file_name().map(|name| parent.join(name)))
            .unwrap_or_else(|| path.to_path_buf())
    })
}

fn memory_id(session_id: &str, scope: &MemoryScope, key: &str) -> String {
    let namespace = match scope {
        MemoryScope::Session => session_id,
        MemoryScope::Project => "project",
        MemoryScope::Global => "global",
    };
    let value = format!("{namespace}:{scope:?}:{}", normalize_key(key));
    format!(
        "m:{}",
        hex::encode(Sha256::digest(value.as_bytes()))[..24].to_owned()
    )
}

fn is_sensitive_candidate(key: &str, value: &str) -> bool {
    let text = format!("{} {}", key.to_lowercase(), value.to_lowercase());
    [
        "api_key",
        "api-key",
        "password",
        "private key",
        "authorization: bearer",
        "refresh_token",
        "access_token",
        "client_secret",
    ]
    .iter()
    .any(|marker| text.contains(marker))
        || value.contains("-----BEGIN ")
        || value.split_whitespace().any(|part| {
            (part.starts_with("sk-")
                || part.starts_with("ghp_")
                || part.starts_with("glpat-")
                || part.starts_with("xoxb-")
                || part.starts_with("AIza")
                || part.starts_with("AKIA")
                || part.starts_with("ASIA"))
                && part.len() > 16
        })
        || (value.starts_with("eyJ") && value.matches('.').count() >= 2 && value.len() > 40)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_preference_promotes_but_model_output_does_not_verify_itself() {
        let project = tempfile::tempdir().unwrap();
        let stores = tempfile::tempdir().unwrap();
        let mut service = TstService::open(
            project.path(),
            stores.path().join("project"),
            stores.path().join("global"),
        )
        .unwrap();
        service
            .remember(RememberInput {
                session_id: "s".into(),
                key: "style".into(),
                value: "use tabs".into(),
                kind: MemoryKind::Preference,
                scope: MemoryScope::Project,
                pinned: false,
                file_hashes: BTreeMap::new(),
            })
            .unwrap();
        let output = service.query(QueryInput {
            session_id: "s".into(),
            query: "style".into(),
            limit: 10,
        });
        assert_eq!(output.ltm.len(), 1);

        let id = service
            .observe(ObserveInput {
                session_id: "s".into(),
                key: "behavior".into(),
                value: "tests pass".into(),
                kind: MemoryKind::BehavioralClaim,
                scope: MemoryScope::Project,
                provenance: Provenance::ModelCandidate,
                pinned: false,
                file_hashes: BTreeMap::new(),
            })
            .unwrap();
        for _ in 0..4 {
            service
                .record_evidence(EvidenceInput {
                    session_id: "s".into(),
                    memory_id: id.clone(),
                    kind: EvidenceKind::SecondaryModel,
                    reference: "secondary".into(),
                    success: true,
                    content_hash: None,
                })
                .unwrap();
        }
        let output = service.query(QueryInput {
            session_id: "s".into(),
            query: "behavior".into(),
            limit: 10,
        });
        assert!(output.ltm.is_empty());
    }

    #[test]
    fn secret_bearing_candidate_is_rejected() {
        let project = tempfile::tempdir().unwrap();
        let stores = tempfile::tempdir().unwrap();
        let mut service = TstService::open(
            project.path(),
            stores.path().join("project"),
            stores.path().join("global"),
        )
        .unwrap();
        assert!(service
            .observe(ObserveInput {
                session_id: "s".into(),
                key: "api_key".into(),
                value: "sk-this-is-a-secret-value".into(),
                kind: MemoryKind::Preference,
                scope: MemoryScope::Session,
                provenance: Provenance::ExplicitUser,
                pinned: false,
                file_hashes: BTreeMap::new(),
            })
            .is_err());
    }

    #[test]
    fn structural_evidence_must_match_the_current_graph_hash_and_deletes_stale_it() {
        let project = tempfile::tempdir().unwrap();
        let stores = tempfile::tempdir().unwrap();
        let source = "export function answer() { return 42 }\n";
        let source_path = project.path().join("main.ts");
        fs::write(&source_path, source).unwrap();
        let mut service = TstService::open(
            project.path(),
            stores.path().join("project"),
            stores.path().join("global"),
        )
        .unwrap();
        let paths = service.begin_graph_index();
        for path in paths {
            service.index_graph_path(&path);
        }
        service.finish_graph_index();

        let hash = hex::encode(Sha256::digest(source.as_bytes()));
        let id = service
            .observe(ObserveInput {
                session_id: "s".into(),
                key: "answer implementation".into(),
                value: "answer returns 42".into(),
                kind: MemoryKind::StructurePattern,
                scope: MemoryScope::Project,
                provenance: Provenance::Verifier,
                pinned: false,
                file_hashes: BTreeMap::from([("main.ts".into(), hash.clone())]),
            })
            .unwrap();

        service
            .record_evidence(EvidenceInput {
                session_id: "s".into(),
                memory_id: id.clone(),
                kind: EvidenceKind::ContentHash,
                reference: "main.ts".into(),
                success: true,
                content_hash: Some("not-the-current-hash".into()),
            })
            .unwrap();
        assert_eq!(service.status().project.records, 0);

        service
            .record_evidence(EvidenceInput {
                session_id: "s".into(),
                memory_id: id,
                kind: EvidenceKind::ContentHash,
                reference: "main.ts".into(),
                success: true,
                content_hash: Some(hash),
            })
            .unwrap();
        assert_eq!(service.status().project.records, 1);

        fs::remove_file(&source_path).unwrap();
        service.update_graph_path(&source_path).unwrap();
        assert_eq!(service.status().project.stale, 1);
    }

    #[test]
    fn durable_keys_are_canonical_across_sessions() {
        let project = tempfile::tempdir().unwrap();
        let stores = tempfile::tempdir().unwrap();
        let mut service = TstService::open(
            project.path(),
            stores.path().join("project"),
            stores.path().join("global"),
        )
        .unwrap();
        let first = service
            .remember(RememberInput {
                session_id: "first".into(),
                key: "formatting".into(),
                value: "tabs".into(),
                kind: MemoryKind::Preference,
                scope: MemoryScope::Project,
                pinned: false,
                file_hashes: BTreeMap::new(),
            })
            .unwrap();
        let second = service
            .remember(RememberInput {
                session_id: "second".into(),
                key: "formatting".into(),
                value: "spaces".into(),
                kind: MemoryKind::Preference,
                scope: MemoryScope::Project,
                pinned: false,
                file_hashes: BTreeMap::new(),
            })
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(service.status().project.records, 1);
        let result = service.query(QueryInput {
            session_id: "third".into(),
            query: "formatting".into(),
            limit: 10,
        });
        assert_eq!(result.ltm[0].value, "spaces");
    }
}
