use crate::graph::{
    CodeGraph, GraphFileList, GraphLocateResult, GraphQueryResult, GraphSearchResult, GraphStats,
    GraphTraceResult, GraphTraceSummary, GraphTraceSummaryEdge, GraphWorkspaceInfo, PlanProjection,
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
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
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
pub struct ContextObservation {
    pub key: String,
    pub value: String,
    #[serde(default = "default_kind")]
    pub kind: MemoryKind,
    #[serde(default = "default_provenance")]
    pub provenance: Provenance,
    #[serde(default)]
    pub pinned: bool,
}

/// A bounded, model-facing candidate supplied to the STM compaction
/// experiment.  The booleans are evidence about how a file reference was
/// obtained; they are used for ranking only and never grant promotion to LTM.
#[derive(Clone, Debug, Deserialize)]
pub struct StmRefreshCandidate {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: String,
    #[serde(default = "default_kind")]
    pub kind: MemoryKind,
    #[serde(default = "default_provenance")]
    pub provenance: Provenance,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub file_hashes: BTreeMap<String, String>,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub explicit: bool,
    #[serde(default)]
    pub validated: bool,
    #[serde(default)]
    pub tool_touched: bool,
    #[serde(default)]
    pub graph_relevance: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum StmRefreshItem {
    Text(String),
    Candidate(StmRefreshCandidate),
}

#[derive(Clone, Debug, Deserialize)]
pub struct StmFileEvidence {
    pub path: String,
    #[serde(default, alias = "content_hash")]
    pub hash: Option<String>,
    #[serde(default)]
    pub explicit: bool,
    #[serde(default)]
    pub validated: bool,
    #[serde(default)]
    pub tool_touched: bool,
    #[serde(default)]
    pub graph_relevant: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct StmRefreshInput {
    pub session_id: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub requirements: Vec<StmRefreshItem>,
    #[serde(default)]
    pub outcomes: Vec<StmRefreshItem>,
    #[serde(default)]
    pub constraints: Vec<StmRefreshItem>,
    #[serde(default)]
    pub observations: Vec<StmRefreshItem>,
    #[serde(default)]
    pub candidates: Vec<StmRefreshItem>,
    #[serde(default)]
    pub explicit_paths: Vec<String>,
    #[serde(default)]
    pub tool_paths: Vec<String>,
    #[serde(default)]
    pub validated_paths: Vec<String>,
    #[serde(default)]
    pub graph_paths: Vec<String>,
    #[serde(default)]
    pub file_evidence: Vec<StmFileEvidence>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct StmEvictionStats {
    pub previous_unpinned: usize,
    pub candidate_count: usize,
    pub retained: usize,
    pub evicted: usize,
    pub evicted_file_anchors: usize,
    pub evicted_constraints: usize,
    pub pinned_preserved: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct StmRefreshOutput {
    pub records: Vec<MemoryRecord>,
    pub retained: Vec<MemoryRecord>,
    pub paths: Vec<String>,
    pub retained_paths: Vec<String>,
    pub eviction: StmEvictionStats,
    pub eviction_stats: StmEvictionStats,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContextMode {
    #[default]
    Foreground,
    Plan,
    StmOnly,
    StmEvents,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ContextPrepareInput {
    pub session_id: String,
    pub query: String,
    #[serde(default, alias = "context_mode")]
    pub mode: ContextMode,
    #[serde(default = "default_projection_budget", alias = "projection_budget_tokens")]
    pub projection_budget: usize,
    #[serde(default)]
    pub hints: Vec<String>,
    #[serde(default)]
    pub observations: Vec<ContextObservation>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ContextPrepareOutput {
    pub observation_complete: bool,
    pub stm: Vec<MemoryRecord>,
    pub ltm: Vec<MemoryRecord>,
    pub graph: Vec<GraphQueryResult>,
    pub edges: Vec<GraphTraceSummaryEdge>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_projection: Option<PlanProjection>,
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
        self.observe_internal(input, true)
    }

    fn observe_internal(&mut self, input: ObserveInput, promote: bool) -> Result<String> {
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
        if promote {
            self.promote_eligible(&input.session_id)?;
        }
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
        let (stm_limit, ltm_limit, graph_limit) = allocate_retrieval_budget(limit, &input.query);
        let stm = self.session(&input.session_id).query(&input.query, stm_limit);
        let mut ltm = self.project.query(&input.query, ltm_limit);
        if ltm.len() < ltm_limit {
            ltm.extend(self.global.query(&input.query, ltm_limit - ltm.len()));
        }
        let graph = self.graph.query(&input.query, graph_limit);
        QueryOutput { stm, ltm, graph }
    }

    pub fn prepare_context(&mut self, input: ContextPrepareInput) -> ContextPrepareOutput {
        const MAX_OBSERVATIONS: usize = 256;
        const MAX_HINTS: usize = 32;
        let stm_only = matches!(input.mode, ContextMode::StmOnly | ContextMode::StmEvents);
        let stm_events = input.mode == ContextMode::StmEvents;
        let requested = input.observations.len();
        let mut accepted = 0usize;
        for observation in input.observations.into_iter().take(MAX_OBSERVATIONS) {
            let result = self.observe_internal(
                ObserveInput {
                    session_id: input.session_id.clone(),
                    key: bounded_text(&observation.key, 120),
                    value: bounded_text(&observation.value, 1_600),
                    kind: observation.kind,
                    scope: MemoryScope::Session,
                    provenance: observation.provenance,
                    pinned: observation.pinned,
                    file_hashes: BTreeMap::new(),
                },
                !stm_only,
            );
            if result.is_ok() {
                accepted += 1;
            }
        }

        let retrieval_query = std::iter::once(input.query.as_str())
            .chain(input.hints.iter().take(MAX_HINTS).map(String::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        let stm = if stm_events {
            let mut records: Vec<MemoryRecord> = self
                .session(&input.session_id)
                .entries()
                .filter(|record| !record.tombstone && !record.stale)
                .cloned()
                .collect();
            records.sort_by(|left, right| right.updated_ms.cmp(&left.updated_ms));
            records
        } else {
            // Navigation-heavy tasks benefit from exact graph candidates over
            // merely-recent session records, so skip the recent fallback for
            // them. Authoring tasks keep the original behaviour.
            let recent_fallback = if is_navigation_query(&retrieval_query) {
                0
            } else {
                3
            };
            self.session(&input.session_id)
                .query_with_recent(&retrieval_query, 8, recent_fallback)
        };
        if stm_only {
            let paths = paths_for_records(&stm);
            return ContextPrepareOutput {
                observation_complete: requested <= MAX_OBSERVATIONS && accepted == requested,
                stm,
                ltm: Vec::new(),
                graph: Vec::new(),
                edges: Vec::new(),
                paths,
                plan_projection: None,
            };
        }
        let mut ltm = self.project.query(&retrieval_query, 5);
        if ltm.len() < 5 {
            ltm.extend(self.global.query(&retrieval_query, 5 - ltm.len()));
        }
        // Navigation queries fetch a wider graph candidate set so the
        // renderer can choose the strongest symbols within its token cap.
        let navigation = is_navigation_query(&retrieval_query);
        let graph = self
            .graph
            .query(&retrieval_query, if navigation { 10 } else { 8 });
        let mut edges = Vec::new();
        let mut edge_keys = std::collections::HashSet::new();
        for root in graph.iter().take(if navigation { 3 } else { 2 }) {
            let trace = self.graph.trace_summary(&root.node.name, "both", 2, 8).ok();
            for edge in trace.into_iter().flat_map(|item| item.edges) {
                let key = format!(
                    "{}:{}:{:?}:{}:{}",
                    edge.from.path, edge.from.symbol, edge.kind, edge.to.path, edge.to.symbol
                );
                if edge_keys.insert(key) {
                    edges.push(edge);
                }
                if edges.len() == 8 {
                    break;
                }
            }
            if edges.len() == 8 {
                break;
            }
        }
        ContextPrepareOutput {
            observation_complete: requested <= MAX_OBSERVATIONS && accepted == requested,
            stm,
            ltm,
            graph,
            edges,
            paths: Vec::new(),
            plan_projection: (input.mode == ContextMode::Plan)
                .then(|| self.graph.plan_projection(input.projection_budget)),
        }
    }

    /// Refresh the session STM for the opt-in compaction experiment.
    ///
    /// All candidate validation, ranking, and pruning happens before the
    /// session is replaced.  In particular, a rejected candidate cannot
    /// leave a partially refreshed STM behind, and this method never calls
    /// `promote_eligible`, so project/global LTM is untouched.
    pub fn refresh_stm(&mut self, input: StmRefreshInput) -> Result<StmRefreshOutput> {
        const MAX_ITEMS_PER_BUCKET: usize = 64;
        const MAX_PATHS: usize = 128;
        const MAX_FILE_ANCHORS: usize = 32;
        const MAX_CONSTRAINTS: usize = 16;

        let prompt = bounded_text(&format!("{}\n{}", input.prompt, input.query), 6_000);
        let prompt_paths = extract_paths(&prompt);
        let explicit_paths = normalized_paths(
            input
                .explicit_paths
                .iter()
                .take(MAX_PATHS)
                .map(String::as_str)
                .chain(prompt_paths.iter().map(String::as_str))
                .take(MAX_PATHS),
        );
        let tool_paths = normalized_paths(input.tool_paths.iter().take(MAX_PATHS).map(String::as_str));
        let validated_paths =
            normalized_paths(input.validated_paths.iter().take(MAX_PATHS).map(String::as_str));
        let mut graph_paths = normalized_paths(input.graph_paths.iter().take(MAX_PATHS).map(String::as_str));
        if !prompt.trim().is_empty() && graph_paths.len() < MAX_PATHS {
            for hit in self.graph.query(&prompt, 32) {
                let path = normalize_path(&hit.node.path);
                if !path.is_empty() {
                    graph_paths.insert(path);
                }
                if graph_paths.len() == MAX_PATHS {
                    break;
                }
            }
        }

        let mut evidence = HashMap::<String, StmFileEvidence>::new();
        for item in input.file_evidence.into_iter().take(MAX_PATHS) {
            let path = normalize_path(&item.path);
            if path.is_empty() {
                continue;
            }
            evidence
                .entry(path.clone())
                .and_modify(|existing| merge_file_evidence(existing, &item))
                .or_insert(StmFileEvidence { path, ..item });
        }

        let ranking = RefreshRankingContext {
            session_id: &input.session_id,
            prompt: &prompt,
            explicit_paths: &explicit_paths,
            tool_paths: &tool_paths,
            validated_paths: &validated_paths,
            graph_paths: &graph_paths,
            evidence: &evidence,
        };

        let mut candidates = HashMap::<String, RankedStmCandidate>::new();
        if let Some(stm) = self.sessions.get(&input.session_id) {
            for record in stm.entries().filter(|record| !record.tombstone && !record.stale) {
                let candidate = ranked_candidate_from_record(record.clone(), &ranking);
                merge_ranked_candidate(&mut candidates, candidate);
            }
        }

        let mut add_items = |items: Vec<StmRefreshItem>, bucket: &'static str| {
            for (index, item) in items.into_iter().take(MAX_ITEMS_PER_BUCKET).enumerate() {
                let candidate = refresh_item_candidate(&ranking, item, bucket, index)?;
                merge_ranked_candidate(&mut candidates, candidate);
            }
            Ok::<(), anyhow::Error>(())
        };
        add_items(input.requirements, "requirement")?;
        add_items(input.outcomes, "outcome")?;
        add_items(input.constraints, "constraint")?;
        add_items(input.observations, "observation")?;
        add_items(input.candidates, "candidate")?;

        // Explicit and touched paths are first-class anchors even when no
        // surrounding observation happened to mention them.
        let mut anchor_paths = explicit_paths.clone();
        anchor_paths.extend(tool_paths.iter().cloned());
        anchor_paths.extend(validated_paths.iter().cloned());
        anchor_paths.extend(evidence.keys().cloned());
        for path in anchor_paths.into_iter().take(MAX_PATHS) {
            let key = format!("file:{path}");
            if candidates.contains_key(&normalize_key(&key)) {
                continue;
            }
            let file = evidence.get(&path);
            let mut file_hashes = BTreeMap::new();
            if let Some(hash) = file.and_then(|item| item.hash.clone()) {
                file_hashes.insert(path.clone(), hash);
            }
            let candidate = refresh_item_candidate(
                &ranking,
                StmRefreshItem::Candidate(StmRefreshCandidate {
                    key,
                    value: format!("File anchor: {path}"),
                    kind: MemoryKind::StructurePattern,
                    provenance: if file.is_some_and(|item| item.validated) {
                        Provenance::Verifier
                    } else {
                        Provenance::Tool
                    },
                    pinned: false,
                    file_hashes,
                    paths: vec![path.clone()],
                    explicit: explicit_paths.contains(&path),
                    validated: validated_paths.contains(&path) || file.is_some_and(|item| item.validated),
                    tool_touched: tool_paths.contains(&path) || file.is_some_and(|item| item.tool_touched),
                    graph_relevance: f32::from(graph_paths.contains(&path)),
                }),
                "file",
                0,
            )?;
            merge_ranked_candidate(&mut candidates, candidate);
        }

        let previous_unpinned = self
            .sessions
            .get(&input.session_id)
            .map(|stm| stm.entries().filter(|record| !record.pinned).count())
            .unwrap_or(0);
        let candidate_count = candidates.len();
        let mut ranked: Vec<RankedStmCandidate> = candidates.into_values().collect();
        ranked.sort_by(compare_ranked_candidates);

        let pinned: Vec<RankedStmCandidate> = ranked
            .iter()
            .filter(|candidate| candidate.record.pinned)
            .cloned()
            .collect();
        let mut file_anchors: Vec<RankedStmCandidate> = ranked
            .iter()
            .filter(|candidate| !candidate.record.pinned && candidate.is_file_anchor)
            .cloned()
            .collect();
        let mut constraints: Vec<RankedStmCandidate> = ranked
            .iter()
            .filter(|candidate| {
                !candidate.record.pinned && (candidate.is_constraint || !candidate.is_file_anchor)
            })
            .cloned()
            .collect();
        file_anchors.truncate(MAX_FILE_ANCHORS);
        constraints.truncate(MAX_CONSTRAINTS);

        let retained_unpinned = file_anchors
            .iter()
            .chain(constraints.iter())
            .map(|candidate| candidate.record.clone())
            .collect::<Vec<_>>();
        let new_pinned = pinned
            .iter()
            .map(|candidate| candidate.record.clone())
            .collect::<Vec<_>>();
        let mut replacement = new_pinned;
        replacement.extend(retained_unpinned.iter().cloned());

        // The only mutation in this method.  ShortTermMemory stages its own
        // replacement, so an error leaves the original slots and index intact.
        self.session(&input.session_id).replace_unpinned(replacement)?;

        let retained_records: Vec<MemoryRecord> = self
            .sessions
            .get(&input.session_id)
            .map(|stm| stm.entries().cloned().collect())
            .unwrap_or_default();
        let mut retained_paths = HashSet::new();
        for candidate in pinned.iter().chain(file_anchors.iter()).chain(constraints.iter()) {
            retained_paths.extend(candidate.paths.iter().cloned());
        }
        for record in &retained_records {
            for path in record.file_hashes.keys() {
                let normalized = normalize_path(path);
                if !normalized.is_empty() {
                    retained_paths.insert(normalized);
                }
            }
            for path in extract_paths(&format!("{} {}", record.key, record.value)) {
                retained_paths.insert(path);
            }
        }
        let retained_paths: Vec<String> = {
            let mut paths: Vec<String> = retained_paths.into_iter().collect();
            paths.sort();
            paths
        };
        let evicted_file_anchors = ranked
            .iter()
            .filter(|candidate| !candidate.record.pinned && candidate.is_file_anchor)
            .count()
            .saturating_sub(file_anchors.len());
        let evicted_constraints = ranked
            .iter()
            .filter(|candidate| {
                !candidate.record.pinned && (candidate.is_constraint || !candidate.is_file_anchor)
            })
            .count()
            .saturating_sub(constraints.len());
        let stats = StmEvictionStats {
            previous_unpinned,
            candidate_count,
            retained: retained_records.len(),
            evicted: evicted_file_anchors + evicted_constraints,
            evicted_file_anchors,
            evicted_constraints,
            pinned_preserved: retained_records.iter().filter(|record| record.pinned).count(),
        };
        Ok(StmRefreshOutput {
            records: retained_records.clone(),
            retained: retained_records,
            paths: retained_paths.clone(),
            retained_paths,
            eviction: stats.clone(),
            eviction_stats: stats,
        })
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

    pub fn graph_query(&self, query: &str, prefix: Option<&str>, limit: usize) -> Vec<GraphQueryResult> {
        self.graph.query_scoped(query, prefix, limit.clamp(1, 128))
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

#[derive(Clone)]
struct RankedStmCandidate {
    record: MemoryRecord,
    paths: HashSet<String>,
    is_file_anchor: bool,
    is_constraint: bool,
    explicit: bool,
    validated: bool,
    tool_touched: bool,
    graph_relevance: f32,
    prompt_relevance: usize,
}

struct RefreshRankingContext<'a> {
    session_id: &'a str,
    prompt: &'a str,
    explicit_paths: &'a HashSet<String>,
    tool_paths: &'a HashSet<String>,
    validated_paths: &'a HashSet<String>,
    graph_paths: &'a HashSet<String>,
    evidence: &'a HashMap<String, StmFileEvidence>,
}

fn refresh_item_candidate(
    context: &RefreshRankingContext<'_>,
    item: StmRefreshItem,
    bucket: &str,
    index: usize,
) -> Result<RankedStmCandidate> {
    let mut candidate = match item {
        StmRefreshItem::Text(value) => StmRefreshCandidate {
            key: format!("{bucket}:{index}"),
            value,
            kind: if bucket == "outcome" {
                MemoryKind::BehavioralClaim
            } else if bucket == "file" {
                MemoryKind::StructurePattern
            } else {
                MemoryKind::ConceptAnchor
            },
            provenance: if bucket == "file" {
                Provenance::Tool
            } else {
                Provenance::ModelCandidate
            },
            pinned: false,
            file_hashes: BTreeMap::new(),
            paths: Vec::new(),
            explicit: false,
            validated: false,
            tool_touched: bucket == "outcome",
            graph_relevance: 0.0,
        },
        StmRefreshItem::Candidate(candidate) => candidate,
    };
    if candidate.key.trim().is_empty() {
        candidate.key = format!("{bucket}:{index}");
    }
    if candidate.value.trim().is_empty() {
        candidate.value = candidate.key.clone();
    }
    if is_sensitive_candidate(&candidate.key, &candidate.value) {
        return Err(anyhow!("candidate rejected by secret-bearing memory policy"));
    }

    let mut paths = normalized_paths(candidate.paths.iter().map(String::as_str));
    for path in candidate.file_hashes.keys() {
        let normalized = normalize_path(path);
        if !normalized.is_empty() {
            paths.insert(normalized);
        }
    }
    for path in extract_paths(&format!("{} {}", candidate.key, candidate.value)) {
        paths.insert(path);
    }
    let explicit = candidate.explicit
        || paths.iter().any(|path| context.explicit_paths.contains(path))
        || paths
            .iter()
            .any(|path| context.evidence.get(path).is_some_and(|item| item.explicit));
    let validated = candidate.validated
        || candidate.provenance == Provenance::Verifier
        || paths.iter().any(|path| context.validated_paths.contains(path))
        || paths
            .iter()
            .any(|path| context.evidence.get(path).is_some_and(|item| item.validated));
    let tool_touched = candidate.tool_touched
        || candidate.provenance == Provenance::Tool
        || paths.iter().any(|path| context.tool_paths.contains(path))
        || paths
            .iter()
            .any(|path| context.evidence.get(path).is_some_and(|item| item.tool_touched));
    let graph_relevance = candidate.graph_relevance.max(
        if paths.iter().any(|path| {
            context.graph_paths.contains(path)
                || context.evidence.get(path).is_some_and(|item| item.graph_relevant)
        }) {
            1.0
        } else {
            0.0
        },
    );
    let is_constraint = bucket == "constraint";
    let is_file_anchor = !is_constraint && (!paths.is_empty() || !candidate.file_hashes.is_empty());
    let record = MemoryRecord {
        id: memory_id(context.session_id, &MemoryScope::Session, &candidate.key),
        key: bounded_text(&candidate.key, 240),
        normalized_key: normalize_key(&candidate.key),
        value: bounded_text(&candidate.value, 1_600),
        kind: candidate.kind,
        scope: MemoryScope::Session,
        provenance: candidate.provenance,
        score: if candidate.validated || validated {
            0.9
        } else {
            0.5
        },
        pinned: candidate.pinned,
        verified: false,
        stale: false,
        tombstone: false,
        created_ms: now_ms(),
        updated_ms: now_ms(),
        access_count: 0,
        evidence: Vec::new(),
        file_hashes: candidate.file_hashes,
    };
    let prompt_relevance = token_overlap(context.prompt, &format!("{} {}", record.key, record.value));
    Ok(RankedStmCandidate {
        record,
        paths,
        is_file_anchor,
        is_constraint,
        explicit,
        validated,
        tool_touched,
        graph_relevance,
        prompt_relevance,
    })
}

fn ranked_candidate_from_record(
    record: MemoryRecord,
    context: &RefreshRankingContext<'_>,
) -> RankedStmCandidate {
    let mut paths = normalized_paths(record.file_hashes.keys().map(String::as_str));
    paths.extend(extract_paths(&format!("{} {}", record.key, record.value)));
    let explicit = paths.iter().any(|path| context.explicit_paths.contains(path));
    let validated = record.provenance == Provenance::Verifier
        || record.evidence.iter().any(|item| item.success)
        || paths.iter().any(|path| context.validated_paths.contains(path))
        || paths
            .iter()
            .any(|path| context.evidence.get(path).is_some_and(|item| item.validated));
    let tool_touched = record.provenance == Provenance::Tool
        || paths.iter().any(|path| context.tool_paths.contains(path))
        || paths
            .iter()
            .any(|path| context.evidence.get(path).is_some_and(|item| item.tool_touched));
    let graph_relevance = if paths.iter().any(|path| context.graph_paths.contains(path)) {
        1.0
    } else {
        0.0
    };
    let prompt_relevance = token_overlap(context.prompt, &format!("{} {}", record.key, record.value));
    RankedStmCandidate {
        is_file_anchor: !paths.is_empty() || !record.file_hashes.is_empty(),
        is_constraint: false,
        record,
        paths,
        explicit,
        validated,
        tool_touched,
        graph_relevance,
        prompt_relevance,
    }
}

fn merge_ranked_candidate(
    candidates: &mut HashMap<String, RankedStmCandidate>,
    mut candidate: RankedStmCandidate,
) {
    let key = candidate.record.normalized_key.clone();
    if let Some(existing) = candidates.get_mut(&key) {
        if existing.record.pinned {
            existing.paths.extend(candidate.paths.drain());
            existing.explicit |= candidate.explicit;
            existing.validated |= candidate.validated;
            existing.tool_touched |= candidate.tool_touched;
            existing.graph_relevance = existing.graph_relevance.max(candidate.graph_relevance);
            existing.prompt_relevance = existing.prompt_relevance.max(candidate.prompt_relevance);
            return;
        }
        if candidate.record.updated_ms >= existing.record.updated_ms && !candidate.record.value.is_empty() {
            existing.record.value = candidate.record.value.clone();
        }
        existing.record.score = existing.record.score.max(candidate.record.score);
        existing.record.updated_ms = existing.record.updated_ms.max(candidate.record.updated_ms);
        existing.record.access_count = existing.record.access_count.max(candidate.record.access_count);
        existing.record.pinned |= candidate.record.pinned;
        existing
            .record
            .file_hashes
            .extend(candidate.record.file_hashes.clone());
        existing.paths.extend(candidate.paths.drain());
        existing.is_constraint |= candidate.is_constraint;
        existing.is_file_anchor =
            (existing.is_file_anchor || candidate.is_file_anchor) && !existing.is_constraint;
        existing.explicit |= candidate.explicit;
        existing.validated |= candidate.validated;
        existing.tool_touched |= candidate.tool_touched;
        existing.graph_relevance = existing.graph_relevance.max(candidate.graph_relevance);
        existing.prompt_relevance = existing.prompt_relevance.max(candidate.prompt_relevance);
        existing.record.normalized_key = normalize_key(&existing.record.key);
    } else {
        candidates.insert(key, candidate);
    }
}

fn compare_ranked_candidates(left: &RankedStmCandidate, right: &RankedStmCandidate) -> Ordering {
    right
        .explicit
        .cmp(&left.explicit)
        .then_with(|| right.validated.cmp(&left.validated))
        .then_with(|| right.tool_touched.cmp(&left.tool_touched))
        .then_with(|| right.prompt_relevance.cmp(&left.prompt_relevance))
        .then_with(|| {
            right
                .graph_relevance
                .partial_cmp(&left.graph_relevance)
                .unwrap_or(Ordering::Equal)
        })
        .then_with(|| {
            right
                .record
                .score
                .partial_cmp(&left.record.score)
                .unwrap_or(Ordering::Equal)
        })
        .then_with(|| right.record.updated_ms.cmp(&left.record.updated_ms))
        .then_with(|| left.record.normalized_key.cmp(&right.record.normalized_key))
}

fn merge_file_evidence(existing: &mut StmFileEvidence, incoming: &StmFileEvidence) {
    if existing.hash.is_none() {
        existing.hash = incoming.hash.clone();
    }
    existing.explicit |= incoming.explicit;
    existing.validated |= incoming.validated;
    existing.tool_touched |= incoming.tool_touched;
    existing.graph_relevant |= incoming.graph_relevant;
}

fn normalized_paths<'a>(paths: impl Iterator<Item = &'a str>) -> HashSet<String> {
    paths
        .filter_map(|path| {
            let normalized = normalize_path(path);
            (!normalized.is_empty()).then_some(normalized)
        })
        .collect()
}

fn paths_for_records(records: &[MemoryRecord]) -> Vec<String> {
    let mut paths = HashSet::new();
    for record in records {
        paths.extend(record.file_hashes.keys().filter_map(|path| {
            let normalized = normalize_path(path);
            (!normalized.is_empty()).then_some(normalized)
        }));
        paths.extend(extract_paths(&format!("{} {}", record.key, record.value)));
    }
    let mut paths: Vec<String> = paths.into_iter().collect();
    paths.sort();
    paths
}

fn normalize_path(value: &str) -> String {
    let mut path = value
        .trim()
        .trim_matches(|character: char| "`\"'()[]{}<>,;:".contains(character))
        .replace('\\', "/");
    while path.starts_with("./") {
        path = path[2..].to_owned();
    }
    if path.starts_with("http://") || path.starts_with("https://") || path.len() > 512 {
        return String::new();
    }
    path
}

fn extract_paths(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .filter_map(|token| {
            let path = normalize_path(token);
            let looks_like_path = (path.contains('/') || file_extension(&path))
                && !path.starts_with("<")
                && !path.starts_with("-")
                && (path.contains('.') || path.ends_with('/'));
            looks_like_path.then_some(path)
        })
        .collect()
}

fn file_extension(path: &str) -> bool {
    matches!(
        path.rsplit_once('.').map(|(_, extension)| extension),
        Some(
            "ts" | "tsx"
                | "js"
                | "jsx"
                | "rs"
                | "py"
                | "go"
                | "java"
                | "json"
                | "md"
                | "yaml"
                | "yml"
                | "toml"
                | "css"
                | "html"
        )
    )
}

fn token_overlap(query: &str, candidate: &str) -> usize {
    let candidate = normalize_key(candidate);
    normalize_key(query)
        .split_whitespace()
        .filter(|term| term.len() >= 3 && candidate.contains(term))
        .collect::<HashSet<_>>()
        .len()
}

/// True when the query reads like code navigation (refactors, call graphs,
/// symbol lookup) rather than authoring a fresh artifact. Navigation tasks
/// are where graph evidence is strongest and recent-session padding is
/// weakest, so budgets shift accordingly.
fn is_navigation_query(query: &str) -> bool {
    const NAVIGATION_TERMS: [&str; 16] = [
        "rename",
        "refactor",
        "call ",
        "calls ",
        "callgraph",
        "graph",
        "import",
        "export",
        "symbol",
        "trace",
        "propagat",
        "dependency",
        "dependencies",
        "who uses",
        "usages",
        "bug",
    ];
    let lower = query.to_lowercase();
    NAVIGATION_TERMS
        .iter()
        .filter(|term| lower.contains(*term))
        .count()
        >= 2
}

/// Split a retrieval budget across STM/LTM/graph. Neutral queries keep the
/// historical ratio (~20/30/50); navigation-heavy queries shift toward the
/// graph because that is where their answers live.
fn allocate_retrieval_budget(limit: usize, query: &str) -> (usize, usize, usize) {
    if is_navigation_query(query) {
        let stm_limit = (limit / 6).max(1);
        let ltm_limit = (limit / 5).max(1);
        let graph_limit = limit.saturating_sub(stm_limit + ltm_limit).max(1);
        return (stm_limit, ltm_limit, graph_limit);
    }
    let stm_limit = (limit / 5).max(1);
    let ltm_limit = ((limit * 3) / 10).max(1);
    let graph_limit = limit.saturating_sub(stm_limit + ltm_limit).max(1);
    (stm_limit, ltm_limit, graph_limit)
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

fn default_projection_budget() -> usize {
    16_384
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
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
    fn context_preparation_observes_turns_and_returns_recent_memory_with_graph_edges() {
        let project = tempfile::tempdir().unwrap();
        let stores = tempfile::tempdir().unwrap();
        fs::create_dir(project.path().join("src")).unwrap();
        fs::write(
            project.path().join("src/api.ts"),
            "import { saveTask } from './store'; export function createTask() { return saveTask(); }",
        )
        .unwrap();
        fs::write(
            project.path().join("src/store.ts"),
            "export function saveTask() { return true; }",
        )
        .unwrap();
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

        let output = service.prepare_context(ContextPrepareInput {
            session_id: "s".into(),
            query: "Fix createTask in src/api.ts".into(),
            mode: ContextMode::Foreground,
            projection_budget: 0,
            hints: vec!["saveTask".into()],
            observations: vec![ContextObservation {
                key: "turn:user-1".into(),
                value: "Requirement: preserve task creation".into(),
                kind: MemoryKind::ConceptAnchor,
                provenance: Provenance::ModelCandidate,
                pinned: false,
            }],
        });
        assert!(output.observation_complete);
        assert_eq!(output.stm.len(), 1);
        assert!(output.graph.iter().any(|item| item.node.name == "createTask"));
        assert!(output.edges.iter().any(|edge| edge.to.symbol == "saveTask"));

        let rejected = service.prepare_context(ContextPrepareInput {
            session_id: "s".into(),
            query: "continue".into(),
            mode: ContextMode::Foreground,
            projection_budget: 0,
            hints: Vec::new(),
            observations: vec![ContextObservation {
                key: "api_key".into(),
                value: "sk-this-is-a-secret-value".into(),
                kind: MemoryKind::ConceptAnchor,
                provenance: Provenance::ModelCandidate,
                pinned: false,
            }],
        });
        assert!(!rejected.observation_complete);
        assert!(
            !rejected.stm.is_empty(),
            "recent STM should preserve continuity for pronouns"
        );
    }

    #[test]
    fn plan_context_returns_ephemeral_projection_without_changing_foreground_shape() {
        let project = tempfile::tempdir().unwrap();
        let stores = tempfile::tempdir().unwrap();
        fs::write(project.path().join("main.ts"), "export function main() {}\n").unwrap();
        let mut service = TstService::open(
            project.path(),
            stores.path().join("project"),
            stores.path().join("global"),
        )
        .unwrap();
        for path in service.begin_graph_index() {
            service.index_graph_path(&path);
        }
        service.finish_graph_index();

        let foreground = service.prepare_context(ContextPrepareInput {
            session_id: "foreground".into(),
            query: "main".into(),
            mode: ContextMode::Foreground,
            projection_budget: 16_384,
            hints: Vec::new(),
            observations: Vec::new(),
        });
        assert!(foreground.plan_projection.is_none());

        let plan = service.prepare_context(ContextPrepareInput {
            session_id: "plan".into(),
            query: "main".into(),
            mode: ContextMode::Plan,
            projection_budget: 16_384,
            hints: Vec::new(),
            observations: Vec::new(),
        });
        let projection = plan.plan_projection.expect("plan projection");
        assert!(projection.complete);
        assert_eq!(projection.coverage.indexed_files, 1);
    }

    #[test]
    fn stm_refresh_ranks_file_evidence_prunes_atomically_and_preserves_ltm() {
        let project = tempfile::tempdir().unwrap();
        let stores = tempfile::tempdir().unwrap();
        fs::write(
            project.path().join("important.ts"),
            "export const important = true;\n",
        )
        .unwrap();
        let mut service = TstService::open(
            project.path(),
            stores.path().join("project"),
            stores.path().join("global"),
        )
        .unwrap();
        service
            .remember(RememberInput {
                session_id: "s".into(),
                key: "durable preference".into(),
                value: "keep strict formatting".into(),
                kind: MemoryKind::Preference,
                scope: MemoryScope::Project,
                pinned: false,
                file_hashes: BTreeMap::new(),
            })
            .unwrap();
        service
            .observe(ObserveInput {
                session_id: "s".into(),
                key: "pinned constraint".into(),
                value: "never remove the API".into(),
                kind: MemoryKind::ConceptAnchor,
                scope: MemoryScope::Session,
                provenance: Provenance::ExplicitUser,
                pinned: true,
                file_hashes: BTreeMap::new(),
            })
            .unwrap();
        service
            .observe(ObserveInput {
                session_id: "s".into(),
                key: "unrelated old note".into(),
                value: "old context".into(),
                kind: MemoryKind::ConceptAnchor,
                scope: MemoryScope::Session,
                provenance: Provenance::ModelCandidate,
                pinned: false,
                file_hashes: BTreeMap::new(),
            })
            .unwrap();

        let output = service
            .refresh_stm(StmRefreshInput {
                session_id: "s".into(),
                query: "fix important.ts".into(),
                prompt: "Fix important.ts without changing the API".into(),
                requirements: vec![
                    StmRefreshItem::Candidate(StmRefreshCandidate {
                        key: "important implementation".into(),
                        value: "Update important.ts and preserve the API".into(),
                        kind: MemoryKind::StructurePattern,
                        provenance: Provenance::ModelCandidate,
                        pinned: false,
                        file_hashes: BTreeMap::new(),
                        paths: vec!["important.ts".into()],
                        explicit: true,
                        validated: false,
                        tool_touched: false,
                        graph_relevance: 1.0,
                    }),
                    StmRefreshItem::Candidate(StmRefreshCandidate {
                        key: "pinned constraint".into(),
                        value: "replace this text must not overwrite the pin".into(),
                        kind: MemoryKind::ConceptAnchor,
                        provenance: Provenance::ModelCandidate,
                        pinned: false,
                        file_hashes: BTreeMap::new(),
                        paths: Vec::new(),
                        explicit: false,
                        validated: false,
                        tool_touched: false,
                        graph_relevance: 0.0,
                    }),
                ],
                outcomes: Vec::new(),
                constraints: Vec::new(),
                observations: Vec::new(),
                candidates: Vec::new(),
                explicit_paths: vec!["important.ts".into()],
                tool_paths: Vec::new(),
                validated_paths: Vec::new(),
                graph_paths: vec!["important.ts".into()],
                file_evidence: vec![StmFileEvidence {
                    path: "important.ts".into(),
                    hash: None,
                    explicit: true,
                    validated: true,
                    tool_touched: true,
                    graph_relevant: true,
                }],
            })
            .unwrap();
        assert!(output.paths.iter().any(|path| path == "important.ts"));
        assert!(output.retained.iter().any(|record| record.pinned));
        assert_eq!(
            output
                .retained
                .iter()
                .find(|record| record.key == "pinned constraint")
                .map(|record| record.value.as_str()),
            Some("never remove the API")
        );
        assert_eq!(service.status().project.records, 1, "refresh must not modify LTM");

        let before = service
            .query(QueryInput {
                session_id: "s".into(),
                query: "important".into(),
                limit: 10,
            })
            .stm;
        assert!(!before.is_empty());
        let failed = service.refresh_stm(StmRefreshInput {
            session_id: "s".into(),
            query: "continue".into(),
            prompt: String::new(),
            requirements: vec![StmRefreshItem::Candidate(StmRefreshCandidate {
                key: "api_key".into(),
                value: "sk-this-is-a-secret-value".into(),
                kind: MemoryKind::ConceptAnchor,
                provenance: Provenance::ModelCandidate,
                pinned: false,
                file_hashes: BTreeMap::new(),
                paths: Vec::new(),
                explicit: false,
                validated: false,
                tool_touched: false,
                graph_relevance: 0.0,
            })],
            outcomes: Vec::new(),
            constraints: Vec::new(),
            observations: Vec::new(),
            candidates: Vec::new(),
            explicit_paths: Vec::new(),
            tool_paths: Vec::new(),
            validated_paths: Vec::new(),
            graph_paths: Vec::new(),
            file_evidence: Vec::new(),
        });
        assert!(failed.is_err());
        let after = service
            .query(QueryInput {
                session_id: "s".into(),
                query: "important".into(),
                limit: 10,
            })
            .stm;
        assert_eq!(
            before.iter().map(|record| &record.id).collect::<Vec<_>>(),
            after.iter().map(|record| &record.id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn stm_only_context_does_not_promote_or_return_ltm_or_graph() {
        let project = tempfile::tempdir().unwrap();
        let stores = tempfile::tempdir().unwrap();
        fs::write(project.path().join("main.ts"), "export const main = true;\n").unwrap();
        let mut service = TstService::open(
            project.path(),
            stores.path().join("project"),
            stores.path().join("global"),
        )
        .unwrap();
        let output = service.prepare_context(ContextPrepareInput {
            session_id: "stm-only".into(),
            query: "main.ts".into(),
            mode: ContextMode::StmOnly,
            projection_budget: 16_384,
            hints: Vec::new(),
            observations: vec![ContextObservation {
                key: "preference".into(),
                value: "use strict formatting".into(),
                kind: MemoryKind::Preference,
                provenance: Provenance::ExplicitUser,
                pinned: false,
            }],
        });
        assert!(output.ltm.is_empty());
        assert!(output.graph.is_empty());
        assert!(output.plan_projection.is_none());
        assert_eq!(service.status().project.records, 0);
    }

    #[test]
    fn stm_events_context_returns_all_retained_session_events_without_ltm_or_graph() {
        let project = tempfile::tempdir().unwrap();
        let stores = tempfile::tempdir().unwrap();
        fs::write(project.path().join("main.ts"), "export const main = true;\n").unwrap();
        let mut service = TstService::open(
            project.path(),
            stores.path().join("project"),
            stores.path().join("global"),
        )
        .unwrap();
        for index in 0..12 {
            service
                .observe(ObserveInput {
                    session_id: "stm-events".into(),
                    key: format!("tool:call-{index}"),
                    value: format!(
                        "{{\"type\":\"tool_event\",\"tool\":\"read\",\"call_id\":\"call-{index}\"}}"
                    ),
                    kind: MemoryKind::StructurePattern,
                    scope: MemoryScope::Session,
                    provenance: Provenance::Tool,
                    pinned: false,
                    file_hashes: BTreeMap::new(),
                })
                .unwrap();
        }
        let output = service.prepare_context(ContextPrepareInput {
            session_id: "stm-events".into(),
            query: "unrelated prompt".into(),
            mode: ContextMode::StmEvents,
            projection_budget: 0,
            hints: Vec::new(),
            observations: Vec::new(),
        });
        assert_eq!(output.stm.len(), 12);
        assert!(output
            .stm
            .iter()
            .all(|record| record.key.starts_with("tool:call-")));
        assert!(output.ltm.is_empty());
        assert!(output.graph.is_empty());
        assert!(output.plan_projection.is_none());
    }

    #[test]
    fn stm_refresh_bounds_file_anchors_and_constraints_independently() {
        let project = tempfile::tempdir().unwrap();
        let stores = tempfile::tempdir().unwrap();
        let mut service = TstService::open(
            project.path(),
            stores.path().join("project"),
            stores.path().join("global"),
        )
        .unwrap();
        let anchors = (0..40)
            .map(|index| {
                StmRefreshItem::Candidate(StmRefreshCandidate {
                    key: format!("anchor-{index}"),
                    value: format!("retain src/file-{index}.ts"),
                    kind: MemoryKind::StructurePattern,
                    provenance: Provenance::Tool,
                    pinned: false,
                    file_hashes: BTreeMap::new(),
                    paths: vec![format!("src/file-{index}.ts")],
                    explicit: false,
                    validated: false,
                    tool_touched: true,
                    graph_relevance: 0.0,
                })
            })
            .collect();
        let constraints = (0..20)
            .map(|index| {
                StmRefreshItem::Candidate(StmRefreshCandidate {
                    key: format!("constraint-{index}"),
                    value: format!("constraint {index}: preserve the public API"),
                    kind: MemoryKind::ConceptAnchor,
                    provenance: Provenance::ModelCandidate,
                    pinned: false,
                    file_hashes: BTreeMap::new(),
                    paths: Vec::new(),
                    explicit: false,
                    validated: false,
                    tool_touched: false,
                    graph_relevance: 0.0,
                })
            })
            .collect();
        let output = service
            .refresh_stm(StmRefreshInput {
                session_id: "bounds".into(),
                query: String::new(),
                prompt: String::new(),
                requirements: Vec::new(),
                outcomes: Vec::new(),
                constraints,
                observations: Vec::new(),
                candidates: anchors,
                explicit_paths: Vec::new(),
                tool_paths: Vec::new(),
                validated_paths: Vec::new(),
                graph_paths: Vec::new(),
                file_evidence: Vec::new(),
            })
            .unwrap();
        assert_eq!(output.eviction.evicted_file_anchors, 8);
        assert_eq!(output.eviction.evicted_constraints, 4);
        assert_eq!(output.eviction.retained, 48);
        assert_eq!(output.paths.len(), 32);
    }

    #[test]
    fn protocol_identity_is_v3() {
        assert_eq!(PROTOCOL_VERSION, "cuppet.tst.v3");
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
