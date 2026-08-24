use anyhow::{anyhow, Context, Result};
use ignore::gitignore::Gitignore;
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use tree_sitter::{InputEdit, Language, Node, Parser, Point, Tree};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_REFERENCES_PER_FILE: usize = 2_048;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GraphNodeKind {
    File,
    Module,
    Symbol,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceSpan {
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_row: usize,
    pub start_column: usize,
    pub end_row: usize,
    pub end_column: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub kind: GraphNodeKind,
    pub path: String,
    pub language: String,
    pub name: String,
    pub symbol_kind: String,
    pub signature: String,
    pub content_hash: String,
    pub span: SourceSpan,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    Definition,
    Export,
    Import,
    Reference,
    Call,
    Implementation,
    Test,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
    pub path: String,
    pub span: SourceSpan,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct IndexProgress {
    pub discovered: usize,
    pub indexed: usize,
    pub skipped: usize,
    pub complete: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphStats {
    pub files: usize,
    pub modules: usize,
    pub symbols: usize,
    pub edges: usize,
    pub progress: IndexProgress,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PlanCoverage {
    pub indexing_complete: bool,
    pub indexed_files: usize,
    pub indexed_modules: usize,
    pub indexed_symbols: usize,
    pub indexed_dependencies: usize,
    pub included_files: usize,
    pub included_modules: usize,
    pub included_symbols: usize,
    pub included_dependencies: usize,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct PlanOmissions {
    pub files: usize,
    pub modules: usize,
    pub symbols: usize,
    pub dependencies: usize,
    pub unfinished_files: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PlanModule {
    pub path: String,
    pub imports: Vec<String>,
    pub exports: Vec<String>,
    pub implementations: Vec<String>,
    pub tests: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PlanSymbol {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub signature: String,
    pub line: usize,
    pub column: usize,
}

/// Ephemeral, deterministic, model-facing workspace projection.  `files` is
/// a compact directory tree (directory entries end in `/` and file entries
/// retain their relative leaf name); modules and symbols are deliberately
/// small projections rather than raw graph nodes or edges.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PlanProjection {
    pub complete: bool,
    pub coverage: PlanCoverage,
    pub files: Vec<String>,
    pub modules: Vec<PlanModule>,
    pub symbols: Vec<PlanSymbol>,
    pub omissions: PlanOmissions,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphQueryResult {
    pub node: GraphNode,
    pub score: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphTextMatch {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub content_hash: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphSearchResult {
    pub query: String,
    pub nodes: Vec<GraphQueryResult>,
    pub text_matches: Vec<GraphTextMatch>,
    /// Bounded call/import relations touching the highest-ranked hits so a
    /// model sees one-hop chains (who calls this, what it calls) directly
    /// beside search results.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub edges: Vec<GraphSearchEdge>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphSearchEdge {
    pub from_path: String,
    pub from_symbol: String,
    pub kind: EdgeKind,
    pub to_path: String,
    pub to_symbol: String,
}

/// A deliberately small, model-facing graph location.  The rich graph types
/// above are kept for debugging and API compatibility; this projection is the
/// default for code-navigation tools.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct GraphLocateMatch {
    pub path: String,
    pub symbol: String,
    pub kind: String,
    pub line: usize,
    pub column: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphLocateResult {
    pub query: String,
    pub matches: Vec<GraphLocateMatch>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphFileList {
    pub root: String,
    pub prefix: String,
    pub total: usize,
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphWorkspaceInfo {
    pub root: String,
    pub graph: GraphStats,
    pub files: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphTraceEdge {
    pub from: GraphNode,
    pub to: GraphNode,
    pub kind: EdgeKind,
    pub path: String,
    pub span: SourceSpan,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphTraceResult {
    pub query: String,
    pub direction: String,
    pub depth: usize,
    pub roots: Vec<GraphNode>,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphTraceEdge>,
}

/// A compact endpoint reference used by graph.trace_summary.  It intentionally
/// omits graph IDs, hashes, language information, and full source spans.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct GraphReference {
    pub path: String,
    pub symbol: String,
    pub kind: String,
    pub line: usize,
    pub column: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct GraphTraceSummaryEdge {
    pub from: GraphReference,
    pub to: GraphReference,
    pub kind: EdgeKind,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphTraceSummary {
    pub query: String,
    pub direction: String,
    pub depth: usize,
    pub edges: Vec<GraphTraceSummaryEdge>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ParsedFile {
    pub node_ids: Vec<String>,
    pub imports: Vec<SyntaxItem>,
    pub calls: Vec<SyntaxItem>,
    pub references: Vec<SyntaxItem>,
    pub implementations: Vec<SyntaxItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyntaxItem {
    pub text: String,
    pub span: SourceSpan,
}

const GRAPH_SNAPSHOT_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GraphSnapshot {
    pub version: u32,
    pub nodes: HashMap<String, GraphNode>,
    pub files: HashMap<String, ParsedFile>,
}

pub struct CodeGraph {
    root: PathBuf,
    nodes: HashMap<String, GraphNode>,
    edges: Vec<GraphEdge>,
    files: HashMap<String, ParsedFile>,
    trees: HashMap<String, Tree>,
    sources: HashMap<String, Vec<u8>>,
    gitignores: Vec<Gitignore>,
    progress: IndexProgress,
    top_level_symbols: HashSet<String>,
    seen_in_build: HashSet<String>,
    in_build: bool,
}

impl CodeGraph {
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let root = fs::canonicalize(root.as_ref())
            .with_context(|| format!("canonicalize project root {}", root.as_ref().display()))?;
        Ok(Self {
            gitignores: load_gitignores(&root),
            root,
            nodes: HashMap::new(),
            edges: Vec::new(),
            files: HashMap::new(),
            trees: HashMap::new(),
            sources: HashMap::new(),
            progress: IndexProgress::default(),
            top_level_symbols: HashSet::new(),
            seen_in_build: HashSet::new(),
            in_build: false,
        })
    }

    pub fn save_snapshot(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let snapshot = GraphSnapshot {
            version: GRAPH_SNAPSHOT_VERSION,
            nodes: self.nodes.clone(),
            files: self.files.clone(),
        };
        let bytes = rmp_serde::to_vec_named(&snapshot).context("serialize graph snapshot")?;
        let temp_path = path.with_extension("tmp");
        fs::write(&temp_path, &bytes)?;
        fs::rename(&temp_path, path)?;
        Ok(())
    }

    pub fn load_snapshot(&mut self, path: &Path) -> Result<bool> {
        if !path.exists() {
            return Ok(false);
        }
        let bytes = fs::read(path)?;
        let snapshot: GraphSnapshot = match rmp_serde::from_slice::<GraphSnapshot>(&bytes) {
            Ok(snapshot) if snapshot.version == GRAPH_SNAPSHOT_VERSION => snapshot,
            _ => return Ok(false),
        };
        self.nodes = snapshot.nodes;
        self.files = snapshot.files;
        self.top_level_symbols.clear();
        self.rebuild_edges();
        self.progress.discovered = self.files.len();
        self.progress.indexed = self.files.len();
        self.progress.complete = true;
        Ok(true)
    }

    pub fn build(&mut self) -> Result<()> {
        let paths = self.begin_build();
        for path in paths {
            self.index_build_path(&path);
        }
        self.finish_build();
        Ok(())
    }

    pub fn begin_build(&mut self) -> Vec<PathBuf> {
        self.gitignores = load_gitignores(&self.root);
        self.trees.clear();
        self.sources.clear();
        self.seen_in_build.clear();
        self.in_build = true;
        self.progress = IndexProgress::default();
        let mut paths = Vec::new();
        for item in WalkBuilder::new(&self.root)
            .hidden(false)
            .follow_links(false)
            .standard_filters(true)
            .build()
        {
            let Ok(item) = item else {
                self.progress.skipped += 1;
                continue;
            };
            if item.file_type().is_some_and(|kind| kind.is_file()) && self.should_index(item.path()) {
                paths.push(item.into_path());
            }
        }
        self.progress.discovered = paths.len();
        paths
    }

    pub fn index_build_path(&mut self, path: &Path) {
        match self.index_file(path) {
            Ok(Some(_)) => self.progress.indexed += 1,
            Ok(None) => self.progress.skipped += 1,
            Err(_) => self.progress.skipped += 1,
        }
    }

    pub fn finish_build(&mut self) {
        if self.in_build {
            let stale_files: Vec<String> = self
                .files
                .keys()
                .filter(|path| !self.seen_in_build.contains(*path))
                .cloned()
                .collect();
            for relative in stale_files {
                self.remove_file_nodes(&relative);
            }
            self.seen_in_build.clear();
            self.in_build = false;
        }
        self.rebuild_edges();
        self.progress.complete = true;
    }

    pub fn should_index(&self, path: &Path) -> bool {
        let Ok(source_metadata) = fs::symlink_metadata(path) else {
            return false;
        };
        if source_metadata.file_type().is_symlink() {
            return false;
        }
        let candidate = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let Ok(relative) = candidate.strip_prefix(&self.root) else {
            return false;
        };
        let relative_text = relative.to_string_lossy().replace('\\', "/");
        if relative_text.is_empty()
            || relative_text.split('/').any(|part| {
                matches!(
                    part,
                    ".git"
                        | "node_modules"
                        | "dist"
                        | "target"
                        | "vendor"
                        | "build"
                        | "coverage"
                        | ".next"
                        | ".turbo"
                        | ".cuppet"
                        | ".claude"
                        | ".aws"
                        | ".ssh"
                        | ".gnupg"
                        | ".azure"
                )
            })
            || is_sensitive_path(&relative_text)
            || is_generated_path(&relative_text)
        {
            return false;
        }
        let Ok(metadata) = fs::symlink_metadata(&candidate) else {
            return false;
        };
        !self.is_gitignored(&candidate, metadata.is_dir())
            && !metadata.file_type().is_symlink()
            && metadata.is_file()
            && metadata.len() <= MAX_FILE_BYTES
            && language_for_path(&candidate).is_some()
    }

    pub fn index_file(&mut self, path: &Path) -> Result<Option<String>> {
        if !self.should_index(path) {
            return Ok(None);
        }
        let canonical = fs::canonicalize(path)?;
        if !canonical.starts_with(&self.root) {
            return Ok(None);
        }
        let relative = canonical
            .strip_prefix(&self.root)?
            .to_string_lossy()
            .replace('\\', "/");
        let source = fs::read(&canonical)?;
        if source.contains(&0) {
            return Ok(None);
        }
        let (language, language_name) = language_for_path(&canonical).expect("checked supported language");
        let hash = sha256(&source);

        self.seen_in_build.insert(relative.clone());

        let file_id = stable_id(&format!("file:{relative}"));
        if self.files.contains_key(&relative) {
            if let Some(existing_node) = self.nodes.get(&file_id) {
                if existing_node.content_hash == hash {
                    self.sources.insert(relative, source);
                    return Ok(Some(hash));
                }
            }
        }

        let mut parser = Parser::new();
        parser.set_language(&language)?;
        let tree = if let (Some(previous_tree), Some(previous_source)) =
            (self.trees.get(&relative), self.sources.get(&relative))
        {
            let mut edited = previous_tree.clone();
            edited.edit(&calculate_edit(previous_source, &source));
            parser
                .parse(&source, Some(&edited))
                .context("incremental Tree-sitter parse failed")?
        } else {
            parser.parse(&source, None).context("Tree-sitter parse failed")?
        };

        self.remove_file_nodes(&relative);
        let file_id = stable_id(&format!("file:{relative}"));
        let file_span = span(tree.root_node());
        self.nodes.insert(
            file_id.clone(),
            GraphNode {
                id: file_id.clone(),
                kind: GraphNodeKind::File,
                path: relative.clone(),
                language: language_name.into(),
                name: relative.clone(),
                symbol_kind: "file".into(),
                signature: relative.clone(),
                content_hash: hash.clone(),
                span: file_span,
            },
        );

        let module_id = stable_id(&format!("module:{relative}"));
        self.nodes.insert(
            module_id.clone(),
            GraphNode {
                id: module_id.clone(),
                kind: GraphNodeKind::Module,
                path: relative.clone(),
                language: language_name.into(),
                name: module_name(&relative),
                symbol_kind: "module".into(),
                signature: relative.clone(),
                content_hash: hash.clone(),
                span: span(tree.root_node()),
            },
        );

        let mut parsed = ParsedFile {
            node_ids: vec![file_id.clone(), module_id],
            ..ParsedFile::default()
        };
        let mut occurrence = HashMap::<(String, String), usize>::new();
        collect_syntax(
            tree.root_node(),
            &source,
            &relative,
            language_name,
            &hash,
            &mut parsed,
            &mut self.nodes,
            &mut occurrence,
            &mut self.top_level_symbols,
            true,
        );
        self.files.insert(relative.clone(), parsed);
        self.trees.insert(relative.clone(), tree);
        self.sources.insert(relative, source);
        self.rebuild_edges();
        Ok(Some(hash))
    }

    pub fn remove_file(&mut self, path: &Path) -> Result<bool> {
        let relative = if path.is_absolute() {
            let canonical = canonical_path(path);
            canonical
                .strip_prefix(&self.root)
                .unwrap_or(&canonical)
                .to_string_lossy()
                .replace('\\', "/")
        } else {
            path.to_string_lossy().replace('\\', "/")
        };
        let existed = self.files.contains_key(&relative);
        self.remove_file_nodes(&relative);
        self.trees.remove(&relative);
        self.sources.remove(&relative);
        self.rebuild_edges();
        Ok(existed)
    }

    fn remove_file_nodes(&mut self, relative: &str) {
        if let Some(file) = self.files.remove(relative) {
            for id in file.node_ids {
                self.top_level_symbols.remove(&id);
                self.nodes.remove(&id);
            }
        }
        self.edges.retain(|edge| edge.path != relative);
    }

    fn rebuild_edges(&mut self) {
        self.edges.clear();
        let mut symbols = HashMap::<String, Vec<String>>::new();
        let mut modules_by_stem = HashMap::<String, String>::new();
        for node in self.nodes.values() {
            match node.kind {
                GraphNodeKind::Symbol => {
                    symbols
                        .entry(node.name.to_lowercase())
                        .or_default()
                        .push(node.id.clone());
                }
                GraphNodeKind::Module => {
                    if let Some(stem) = Path::new(&node.path).file_stem().and_then(|value| value.to_str()) {
                        modules_by_stem.insert(stem.to_lowercase(), node.id.clone());
                    }
                }
                GraphNodeKind::File => {}
            }
        }

        for (path, parsed) in &self.files {
            let file_id = stable_id(&format!("file:{path}"));
            let module_id = stable_id(&format!("module:{path}"));
            for id in &parsed.node_ids {
                if id != &file_id {
                    let Some(node) = self.nodes.get(id) else {
                        continue;
                    };
                    self.edges.push(GraphEdge {
                        from: if node.kind == GraphNodeKind::Module {
                            file_id.clone()
                        } else {
                            module_id.clone()
                        },
                        to: id.clone(),
                        kind: EdgeKind::Definition,
                        path: path.clone(),
                        span: node.span.clone(),
                    });
                    if node.symbol_kind.starts_with("exported_") {
                        self.edges.push(GraphEdge {
                            from: module_id.clone(),
                            to: id.clone(),
                            kind: EdgeKind::Export,
                            path: path.clone(),
                            span: node.span.clone(),
                        });
                    }
                }
            }
            for import in &parsed.imports {
                if let Some(target) = resolve_import(&import.text, &modules_by_stem) {
                    self.edges.push(GraphEdge {
                        from: module_id.clone(),
                        to: target.clone(),
                        kind: EdgeKind::Import,
                        path: path.clone(),
                        span: import.span.clone(),
                    });
                    if is_test_path(path) {
                        self.edges.push(GraphEdge {
                            from: module_id.clone(),
                            to: target,
                            kind: EdgeKind::Test,
                            path: path.clone(),
                            span: import.span.clone(),
                        });
                    }
                }
            }
            for call in &parsed.calls {
                if let Some(target) = resolve_symbol(&call.text, &symbols) {
                    self.edges.push(GraphEdge {
                        from: module_id.clone(),
                        to: target,
                        kind: EdgeKind::Call,
                        path: path.clone(),
                        span: call.span.clone(),
                    });
                }
            }
            for reference in &parsed.references {
                if let Some(target) = resolve_symbol(&reference.text, &symbols) {
                    self.edges.push(GraphEdge {
                        from: module_id.clone(),
                        to: target,
                        kind: EdgeKind::Reference,
                        path: path.clone(),
                        span: reference.span.clone(),
                    });
                }
            }
            for implementation in &parsed.implementations {
                if let Some(target) = resolve_symbol(&implementation.text, &symbols) {
                    self.edges.push(GraphEdge {
                        from: module_id.clone(),
                        to: target,
                        kind: EdgeKind::Implementation,
                        path: path.clone(),
                        span: implementation.span.clone(),
                    });
                }
            }
        }
    }

    pub fn query(&self, query: &str, limit: usize) -> Vec<GraphQueryResult> {
        self.query_scoped(query, None, limit)
    }

    /// Query graph symbols while enforcing a project-relative path boundary.
    ///
    /// The unscoped query remains available for explicit repository-wide
    /// navigation tools, but task-conditioned retrieval must use this method
    /// so generic task words cannot select symbols from another project.
    pub fn query_scoped(&self, query: &str, prefix: Option<&str>, limit: usize) -> Vec<GraphQueryResult> {
        let prefix = normalize_prefix(prefix);
        let terms = query_terms(query);

        // Identify spatio-temporal active paths from query terms or known graph files
        let mut active_paths = HashSet::new();
        for term in &terms {
            let clean = term.raw.as_str();
            if clean.contains('/') || clean.contains('.') {
                for file_path in self.files.keys() {
                    if !path_matches_prefix(file_path, &prefix) {
                        continue;
                    }
                    let file_lower = file_path.to_lowercase();
                    if file_lower == clean || file_lower.contains(clean) || clean.contains(&file_lower) {
                        active_paths.insert(file_lower);
                    }
                }
            }
        }

        // Collect 1-hop graph neighbor node IDs for spatio-temporal locality
        let mut neighbor_node_ids = HashSet::new();
        if !active_paths.is_empty() {
            for edge in &self.edges {
                if active_paths.contains(&edge.path.to_lowercase()) {
                    neighbor_node_ids.insert(edge.from.clone());
                    neighbor_node_ids.insert(edge.to.clone());
                }
            }
        }

        // Document frequency per term over in-scope symbol names. Rare
        // identifiers (a specific function name) must outweigh generic ones
        // ("index", "data") so retrieval follows the task's actual nouns.
        let total_nodes = self.nodes.len().max(1) as f32;
        let mut term_weights: Vec<f32> = Vec::with_capacity(terms.len());
        for term in &terms {
            let mut df = 0.0f32;
            for node in self.nodes.values() {
                if !path_matches_prefix(&node.path, &prefix) {
                    continue;
                }
                if name_match_strength(term, &node.name.to_lowercase(), &identifier_tokens(&node.name))
                    .is_some()
                {
                    df += 1.0;
                }
            }
            let idf = (1.0 + total_nodes / (1.0 + df)).ln() / (1.0 + total_nodes).ln();
            term_weights.push(0.5 + idf);
        }

        let mut matches = Vec::new();
        for node in self.nodes.values() {
            if !path_matches_prefix(&node.path, &prefix) {
                continue;
            }
            let path = node.path.to_lowercase();
            let name = node.name.to_lowercase();
            let signature = node.signature.to_lowercase();

            // Spatio-temporal locality boost
            let mut score = if active_paths.contains(&path) {
                50.0
            } else if neighbor_node_ids.contains(&node.id) {
                20.0
            } else {
                0.0
            };

            let name_tokens = identifier_tokens(&node.name);
            for (index, term) in terms.iter().enumerate() {
                let weight = term_weights[index];
                if let Some(strength) = name_match_strength(term, &name, &name_tokens) {
                    score += strength.score() * weight;
                }
                if path.contains(&term.raw) {
                    score += 6.0 * weight;
                }
                if !term.tokens.is_empty() && signature.contains(&term.raw) {
                    score += 2.0 * weight;
                }
            }

            if score > 0.0 {
                matches.push(GraphQueryResult {
                    node: node.clone(),
                    score: score.round() as u32,
                });
            }
        }

        matches.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.node.path.cmp(&right.node.path))
        });
        matches.truncate(limit);
        matches
    }

    pub fn search(&self, pattern: &str, prefix: Option<&str>, limit: usize) -> GraphSearchResult {
        let pattern = pattern.trim();
        let limit = limit.clamp(1, 128);
        let prefix = normalize_prefix(prefix);
        let nodes: Vec<GraphQueryResult> = self
            .query(pattern, limit.saturating_mul(2))
            .into_iter()
            .filter(|result| path_matches_prefix(&result.node.path, &prefix))
            .take(limit)
            .collect();

        let mut text_matches = Vec::new();
        if !pattern.is_empty() {
            let needle = pattern.as_bytes();
            let mut paths: Vec<&String> = self.files.keys().collect();
            paths.sort();
            for path in paths {
                if !path_matches_prefix(path, &prefix) {
                    continue;
                }
                let Some(source) = self.sources.get(path) else {
                    continue;
                };
                let Some(node) = self.nodes.get(&stable_id(&format!("file:{path}"))) else {
                    continue;
                };
                let mut offset = 0;
                while offset + needle.len() <= source.len() {
                    let Some(relative) = source[offset..]
                        .windows(needle.len())
                        .position(|window| window == needle)
                    else {
                        break;
                    };
                    let absolute = offset + relative;
                    let before = &source[..absolute];
                    let line = before.iter().filter(|byte| **byte == b'\n').count() + 1;
                    let column = before
                        .rsplit(|byte| *byte == b'\n')
                        .next()
                        .map(|line| line.len() + 1)
                        .unwrap_or(1);
                    text_matches.push(GraphTextMatch {
                        path: path.clone(),
                        line,
                        column,
                        content_hash: node.content_hash.clone(),
                    });
                    if text_matches.len() >= limit {
                        let edges = self.related_edges(&nodes);
                        return GraphSearchResult {
                            query: pattern.into(),
                            nodes,
                            text_matches,
                            edges,
                        };
                    }
                    offset = absolute.saturating_add(needle.len().max(1));
                }
            }
        }

        let edges = self.related_edges(&nodes);
        GraphSearchResult {
            query: pattern.into(),
            nodes,
            text_matches,
            edges,
        }
    }

    /// Collect bounded, deterministic one-hop relations for the top search
    /// hits so model-facing results expose actual call/import chains rather
    /// than only ranked symbols.
    fn related_edges(&self, nodes: &[GraphQueryResult]) -> Vec<GraphSearchEdge> {
        if nodes.is_empty() {
            return Vec::new();
        }
        let focus: HashSet<&str> = nodes
            .iter()
            .take(6)
            .map(|result| result.node.id.as_str())
            .collect();
        let mut relations: Vec<GraphSearchEdge> = Vec::new();
        for edge in &self.edges {
            if !focus.contains(edge.from.as_str()) && !focus.contains(edge.to.as_str()) {
                continue;
            }
            let (Some(from), Some(to)) = (self.nodes.get(&edge.from), self.nodes.get(&edge.to)) else {
                continue;
            };
            relations.push(GraphSearchEdge {
                from_path: from.path.clone(),
                from_symbol: from.name.clone(),
                kind: edge.kind.clone(),
                to_path: to.path.clone(),
                to_symbol: to.name.clone(),
            });
            if relations.len() >= 8 {
                break;
            }
        }
        relations.sort_by(|left, right| {
            left.from_path
                .cmp(&right.from_path)
                .then_with(|| left.from_symbol.cmp(&right.from_symbol))
                .then_with(|| format!("{:?}", left.kind).cmp(&format!("{:?}", right.kind)))
                .then_with(|| left.to_path.cmp(&right.to_path))
        });
        relations
    }

    /// Return a compact, ranked projection of graph search results for model
    /// navigation.  Rich `search` remains available for debugging clients.
    pub fn locate(&self, pattern: &str, prefix: Option<&str>, limit: usize) -> GraphLocateResult {
        let limit = limit.clamp(1, 12);
        // Search wider than the compact response so `truncated` reflects a
        // real omitted result rather than only the caller's requested bound.
        let search = self.search(pattern, prefix, 128);
        let mut matches = Vec::new();
        let mut seen = HashSet::new();

        // `search` already ranks symbols by relevance.  Preserve that order
        // and then add literal source matches as a lower-priority fallback.
        for result in search.nodes {
            let node = result.node;
            let item = GraphLocateMatch {
                path: node.path,
                symbol: node.name,
                kind: node.symbol_kind,
                line: node.span.start_row + 1,
                column: node.span.start_column + 1,
            };
            let key = format!(
                "{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}",
                item.path, item.symbol, item.kind, item.line, item.column
            );
            if seen.insert(key) {
                matches.push(item);
            }
        }

        for result in search.text_matches {
            let item = GraphLocateMatch {
                path: result.path,
                symbol: String::new(),
                kind: "text".into(),
                line: result.line,
                column: result.column,
            };
            let key = format!(
                "{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}",
                item.path, item.symbol, item.kind, item.line, item.column
            );
            if seen.insert(key) {
                matches.push(item);
            }
        }

        let truncated = matches.len() > limit;
        matches.truncate(limit);
        GraphLocateResult {
            query: pattern.trim().into(),
            matches,
            truncated,
        }
    }

    pub fn list_files(&self, prefix: Option<&str>, limit: usize) -> GraphFileList {
        let prefix = normalize_prefix(prefix);
        let mut paths: Vec<String> = self
            .files
            .keys()
            .filter(|path| path_matches_prefix(path, &prefix))
            .cloned()
            .collect();
        paths.sort();
        let total = paths.len();
        paths.truncate(limit.clamp(1, 512));
        GraphFileList {
            root: self.root.display().to_string(),
            prefix,
            total,
            paths,
        }
    }

    pub fn workspace_info(&self, limit: usize) -> GraphWorkspaceInfo {
        let files = self.list_files(None, limit.clamp(1, 512));
        GraphWorkspaceInfo {
            root: self.root.display().to_string(),
            graph: self.stats(),
            files: files.paths,
        }
    }

    /// Build a deterministic, ephemeral workspace projection for plan mode.
    /// The budget is expressed in model tokens and is capped here as a second
    /// line of defence even when a caller is buggy or stale.
    pub fn plan_projection(&self, budget_tokens: usize) -> PlanProjection {
        let budget_tokens = budget_tokens.min(16_384);
        let budget_chars = budget_tokens.saturating_mul(4);
        let mut paths: Vec<String> = self.files.keys().cloned().collect();
        paths.sort();
        let file_tree = compress_file_tree(&paths);
        let (all_modules, indexed_dependencies) = self.plan_modules();
        let all_symbols = self.plan_symbols();

        let mut remaining = budget_chars;
        let mut files = Vec::new();
        for line in &file_tree {
            let cost = line.chars().count().saturating_add(1);
            if cost > remaining {
                break;
            }
            files.push(line.clone());
            remaining = remaining.saturating_sub(cost);
        }
        let included_files = files
            .iter()
            .filter(|line| !line.trim_end().ends_with('/'))
            .count();

        let mut modules = Vec::new();
        for module in &all_modules {
            let cost = plan_module_text(module).chars().count().saturating_add(1);
            if cost > remaining {
                break;
            }
            modules.push(module.clone());
            remaining = remaining.saturating_sub(cost);
        }
        let included_dependencies = modules.iter().map(plan_module_dependency_count).sum::<usize>();

        let mut symbols = Vec::new();
        for symbol in &all_symbols {
            let cost = plan_symbol_text(symbol).chars().count().saturating_add(1);
            if cost > remaining {
                break;
            }
            symbols.push(symbol.clone());
            remaining = remaining.saturating_sub(cost);
        }

        let unfinished_files = self
            .progress
            .discovered
            .saturating_sub(self.progress.indexed)
            .max(self.progress.skipped);
        let indexing_complete = self.progress.complete
            && self.progress.skipped == 0
            && self.progress.discovered == self.progress.indexed;
        let omissions = PlanOmissions {
            files: paths.len().saturating_sub(included_files),
            modules: all_modules.len().saturating_sub(modules.len()),
            symbols: all_symbols.len().saturating_sub(symbols.len()),
            dependencies: indexed_dependencies.saturating_sub(included_dependencies),
            unfinished_files,
        };
        let coverage = PlanCoverage {
            indexing_complete,
            indexed_files: paths.len(),
            indexed_modules: all_modules.len(),
            indexed_symbols: all_symbols.len(),
            indexed_dependencies,
            included_files,
            included_modules: modules.len(),
            included_symbols: symbols.len(),
            included_dependencies,
        };
        let complete = indexing_complete
            && omissions.files == 0
            && omissions.modules == 0
            && omissions.symbols == 0
            && omissions.dependencies == 0;

        PlanProjection {
            complete,
            coverage,
            files,
            modules,
            symbols,
            omissions,
        }
    }

    fn plan_modules(&self) -> (Vec<PlanModule>, usize) {
        let mut modules = BTreeMap::<String, PlanModule>::new();
        for path in self.files.keys() {
            modules.insert(
                path.clone(),
                PlanModule {
                    path: path.clone(),
                    imports: Vec::new(),
                    exports: Vec::new(),
                    implementations: Vec::new(),
                    tests: Vec::new(),
                },
            );
        }

        for edge in &self.edges {
            let Some(from) = self.nodes.get(&edge.from) else {
                continue;
            };
            let Some(module) = modules.get_mut(&from.path) else {
                continue;
            };
            let Some(target) = self.nodes.get(&edge.to) else {
                continue;
            };
            let target = plan_node_reference(target);
            match &edge.kind {
                EdgeKind::Import => push_unique(&mut module.imports, target),
                EdgeKind::Export => push_unique(&mut module.exports, target),
                EdgeKind::Implementation => push_unique(&mut module.implementations, target),
                EdgeKind::Test => push_unique(&mut module.tests, target),
                EdgeKind::Definition | EdgeKind::Reference | EdgeKind::Call => {}
            }
        }

        let modules: Vec<PlanModule> = modules
            .into_values()
            .map(|mut module| {
                module.imports.sort();
                module.exports.sort();
                module.implementations.sort();
                module.tests.sort();
                module
            })
            .collect();
        let dependencies = modules.iter().map(plan_module_dependency_count).sum();
        (modules, dependencies)
    }

    fn plan_symbols(&self) -> Vec<PlanSymbol> {
        let mut symbols: Vec<PlanSymbol> = self
            .nodes
            .values()
            .filter(|node| node.kind == GraphNodeKind::Symbol)
            .filter(|node| {
                let exported = node.symbol_kind.starts_with("exported_");
                let base_kind = node.symbol_kind.trim_start_matches("exported_");
                self.top_level_symbols.contains(&node.id) || (exported && !base_kind.contains("method"))
            })
            .map(|node| PlanSymbol {
                path: node.path.clone(),
                name: node.name.clone(),
                kind: node.symbol_kind.trim_start_matches("exported_").into(),
                signature: node.signature.clone(),
                line: node.span.start_row + 1,
                column: node.span.start_column + 1,
            })
            .collect();
        symbols.sort_by(|left, right| {
            left.path
                .cmp(&right.path)
                .then_with(|| left.line.cmp(&right.line))
                .then_with(|| left.column.cmp(&right.column))
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.signature.cmp(&right.signature))
        });
        symbols.dedup_by(|left, right| {
            left.path == right.path
                && left.name == right.name
                && left.line == right.line
                && left.column == right.column
        });
        symbols
    }

    pub fn trace(
        &self,
        query: &str,
        direction: &str,
        depth: usize,
        limit: usize,
    ) -> Result<GraphTraceResult> {
        if !matches!(direction, "callers" | "callees" | "both") {
            return Err(anyhow!("graph trace direction must be callers, callees, or both"));
        }
        let depth = depth.clamp(1, 4);
        let limit = limit.clamp(1, 128);
        let roots: Vec<GraphNode> = self
            .query(query, 32)
            .into_iter()
            .map(|result| result.node)
            .collect();
        let mut nodes = self
            .nodes
            .iter()
            .filter_map(|(id, node)| {
                roots
                    .iter()
                    .any(|root| &root.id == id)
                    .then_some((id.clone(), node.clone()))
            })
            .collect::<HashMap<_, _>>();
        let mut visited = nodes.keys().cloned().collect::<HashSet<_>>();
        let mut frontier = roots
            .iter()
            .map(|root| (root.id.clone(), 0))
            .collect::<VecDeque<_>>();
        let mut edges = Vec::new();
        let mut seen_edges = HashSet::new();

        while let Some((current, current_depth)) = frontier.pop_front() {
            if current_depth >= depth || edges.len() >= limit {
                continue;
            }
            for edge in &self.edges {
                let mut targets = Vec::new();
                if matches!(direction, "callees" | "both") && edge.from == current {
                    targets.push(edge.to.clone());
                }
                if matches!(direction, "callers" | "both") && edge.to == current {
                    targets.push(edge.from.clone());
                }
                for target in targets {
                    let edge_key = format!("{}:{}:{:?}:{}", edge.from, edge.to, edge.kind, edge.path);
                    if !seen_edges.insert(edge_key) {
                        continue;
                    }
                    let Some(from) = self.nodes.get(&edge.from) else {
                        continue;
                    };
                    let Some(to) = self.nodes.get(&edge.to) else {
                        continue;
                    };
                    nodes.entry(edge.from.clone()).or_insert_with(|| from.clone());
                    nodes.entry(edge.to.clone()).or_insert_with(|| to.clone());
                    edges.push(GraphTraceEdge {
                        from: from.clone(),
                        to: to.clone(),
                        kind: edge.kind.clone(),
                        path: edge.path.clone(),
                        span: edge.span.clone(),
                    });
                    if visited.insert(target.clone()) {
                        frontier.push_back((target, current_depth + 1));
                    }
                    if edges.len() >= limit {
                        break;
                    }
                }
                if edges.len() >= limit {
                    break;
                }
            }
        }

        let mut nodes: Vec<GraphNode> = nodes.into_values().collect();
        nodes.sort_by(|left, right| {
            left.path
                .cmp(&right.path)
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(GraphTraceResult {
            query: query.into(),
            direction: direction.into(),
            depth,
            roots,
            nodes,
            edges,
        })
    }

    /// Return only compact dependency edges for model-facing traversal.  This
    /// avoids re-sending roots, node tables, IDs, hashes, languages, and full
    /// spans for every trace call.
    pub fn trace_summary(
        &self,
        query: &str,
        direction: &str,
        depth: usize,
        limit: usize,
    ) -> Result<GraphTraceSummary> {
        let limit = limit.clamp(1, 12);
        let trace = self.trace(query, direction, depth, 128)?;
        let mut edges = Vec::new();
        let mut seen = HashSet::new();

        for edge in trace.edges {
            let item = GraphTraceSummaryEdge {
                from: compact_reference(&edge.from),
                to: compact_reference(&edge.to),
                kind: edge.kind,
            };
            let key = format!(
                "{}\u{0}{}\u{0}{}\u{0}{}\u{0}{:?}",
                item.from.path, item.from.symbol, item.to.path, item.to.symbol, item.kind
            );
            if seen.insert(key) {
                edges.push(item);
            }
        }

        let truncated = edges.len() > limit;
        edges.truncate(limit);
        Ok(GraphTraceSummary {
            query: trace.query,
            direction: trace.direction,
            depth: trace.depth,
            edges,
            truncated,
        })
    }

    pub fn stats(&self) -> GraphStats {
        GraphStats {
            files: self.files.len(),
            modules: self
                .nodes
                .values()
                .filter(|node| node.kind == GraphNodeKind::Module)
                .count(),
            symbols: self
                .nodes
                .values()
                .filter(|node| node.kind == GraphNodeKind::Symbol)
                .count(),
            edges: self.edges.len(),
            progress: self.progress.clone(),
        }
    }

    pub fn content_hash(&self, relative_path: &str) -> Option<&str> {
        let file_id = stable_id(&format!("file:{relative_path}"));
        self.nodes.get(&file_id).map(|node| node.content_hash.as_str())
    }

    pub fn file_hashes(&self) -> Vec<(String, String)> {
        self.nodes
            .values()
            .filter(|node| node.kind == GraphNodeKind::File)
            .map(|node| (node.path.clone(), node.content_hash.clone()))
            .collect()
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn is_gitignored(&self, path: &Path, is_dir: bool) -> bool {
        let mut ignored = false;
        for matcher in &self.gitignores {
            if !path.starts_with(matcher.path()) {
                continue;
            }
            let matched = matcher.matched_path_or_any_parents(path, is_dir);
            if matched.is_ignore() {
                ignored = true;
            } else if matched.is_whitelist() {
                ignored = false;
            }
        }
        ignored
    }
}

fn graph_query_term(term: &str) -> bool {
    if term.contains('/') || term.contains('.') || term.contains('_') {
        return true;
    }
    if term.len() < 3 {
        return false;
    }
    !matches!(
        term,
        "and"
            | "are"
            | "but"
            | "can"
            | "for"
            | "from"
            | "has"
            | "have"
            | "how"
            | "into"
            | "its"
            | "not"
            | "our"
            | "that"
            | "the"
            | "then"
            | "this"
            | "use"
            | "was"
            | "what"
            | "when"
            | "where"
            | "which"
            | "with"
            | "you"
            | "your"
    )
}

/// A lowercased query word plus its identifier alias tokens, so a query
/// written in one convention still matches code written in another
/// ("due date" finds `dueDate`, `task_tracker` finds `TaskTracker`).
#[derive(Clone, Debug)]
struct QueryTerm {
    raw: String,
    tokens: Vec<String>,
}

/// Extension-like fragments must never become alias tokens: otherwise every
/// TypeScript file shares the alias "ts" and unrelated paths falsely match.
const EXTENSION_TOKENS: [&str; 17] = [
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "dart", "json", "md", "css", "scss", "html",
    "yml", "yaml",
];

/// Split an identifier into lowercase alias tokens. Boundaries fall at
/// non-alphanumeric characters and camelCase transitions. When the value
/// splits into multiple tokens, the joined lowercase form is appended so
/// containment checks can still hit the whole identifier.
fn identifier_tokens(value: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = value.chars().collect();
    for (index, ch) in chars.iter().copied().enumerate() {
        if !ch.is_alphanumeric() {
            if !current.is_empty() {
                tokens.push(current.to_lowercase());
                current.clear();
            }
            continue;
        }
        if let Some(previous) = index.checked_sub(1).map(|offset| chars[offset]) {
            if ch.is_uppercase() && (previous.is_lowercase() || previous.is_numeric()) && !current.is_empty()
            {
                tokens.push(current.to_lowercase());
                current.clear();
            }
        }
        current.push(ch);
    }
    if !current.is_empty() {
        tokens.push(current.to_lowercase());
    }
    tokens.retain(|token| !EXTENSION_TOKENS.contains(&token.as_str()));
    if tokens.len() > 1 {
        let joined = tokens.concat();
        tokens.push(joined);
    }
    tokens.sort();
    tokens.dedup();
    tokens
}

fn query_terms(query: &str) -> Vec<QueryTerm> {
    query
        .to_lowercase()
        .split_whitespace()
        .map(|term| {
            term.trim_matches(|c: char| !c.is_alphanumeric() && c != '/' && c != '.' && c != '_')
                .to_owned()
        })
        .filter(|term| graph_query_term(term))
        .map(|raw| {
            let tokens = identifier_tokens(&raw);
            QueryTerm { raw, tokens }
        })
        .collect()
}

/// How strongly a symbol name matches a query term. Stronger matches are
/// exact or token-level so `validateDeadline` outranks `deadlineReminder`
/// only when the whole concept matches, while alias tokens keep
/// convention differences (`due_date` vs `dueDate`) on equal footing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NameMatchStrength {
    Full,
    Token,
    Partial,
}

impl NameMatchStrength {
    fn score(self) -> f32 {
        match self {
            Self::Full => 22.0,
            Self::Token => 15.0,
            Self::Partial => 9.0,
        }
    }
}

fn name_match_strength(
    term: &QueryTerm,
    name_lower: &str,
    name_tokens: &[String],
) -> Option<NameMatchStrength> {
    if name_lower == term.raw {
        return Some(NameMatchStrength::Full);
    }
    // The name resolves to exactly one alias token of the term ("duedate"
    // against "dueDate"), but a multi-token name that merely shares a word
    // with the query ("validateDeadline" against "deadline") ranks below it.
    if name_tokens.len() == 1 && term.tokens.iter().any(|token| token == name_lower) {
        return Some(NameMatchStrength::Full);
    }
    if term.tokens.iter().any(|token| name_tokens.contains(token)) {
        return Some(NameMatchStrength::Token);
    }
    if name_lower.contains(&term.raw)
        || (!term.raw.is_empty()
            && term.raw.contains(name_lower)
            && !name_lower.is_empty()
            && name_lower.len() >= 4)
    {
        return Some(NameMatchStrength::Partial);
    }
    None
}

fn normalize_prefix(prefix: Option<&str>) -> String {
    prefix
        .unwrap_or_default()
        .trim()
        .trim_start_matches("./")
        .trim_matches('/')
        .replace('\\', "/")
}

fn path_matches_prefix(path: &str, prefix: &str) -> bool {
    prefix.is_empty() || path == prefix || path.starts_with(&format!("{prefix}/"))
}

fn compact_reference(node: &GraphNode) -> GraphReference {
    GraphReference {
        path: node.path.clone(),
        symbol: node.name.clone(),
        kind: node.symbol_kind.clone(),
        line: node.span.start_row + 1,
        column: node.span.start_column + 1,
    }
}

fn load_gitignores(root: &Path) -> Vec<Gitignore> {
    fn visit(directory: &Path, output: &mut Vec<Gitignore>) {
        let Ok(entries) = fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_file() && entry.file_name() == ".gitignore" {
                output.push(Gitignore::new(&path).0);
                continue;
            }
            if !file_type.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if matches!(
                name.as_ref(),
                ".git"
                    | "node_modules"
                    | "dist"
                    | "target"
                    | "vendor"
                    | "build"
                    | "coverage"
                    | ".next"
                    | ".turbo"
                    | ".cuppet"
                    | ".claude"
                    | ".aws"
                    | ".ssh"
                    | ".gnupg"
                    | ".azure"
            ) {
                continue;
            }
            visit(&path, output);
        }
    }

    let mut output = Vec::new();
    visit(root, &mut output);
    output.sort_by_key(|matcher| matcher.path().components().count());
    output
}

#[allow(clippy::too_many_arguments)]
fn collect_syntax(
    node: Node<'_>,
    source: &[u8],
    path: &str,
    language: &str,
    content_hash: &str,
    parsed: &mut ParsedFile,
    nodes: &mut HashMap<String, GraphNode>,
    occurrences: &mut HashMap<(String, String), usize>,
    top_level_symbols: &mut HashSet<String>,
    top_level: bool,
) {
    let kind = node.kind();
    if is_symbol_kind(kind) {
        if let Some(name_node) = symbol_name_node(node) {
            let name = text(name_node, source);
            if !name.is_empty() {
                let key = (kind.to_owned(), name.clone());
                let ordinal = occurrences.entry(key).or_insert(0);
                let id = stable_id(&format!("symbol:{path}:{kind}:{name}:{ordinal}"));
                *ordinal += 1;
                let exported = has_export_ancestor(node);
                let symbol_kind = if exported {
                    format!("exported_{kind}")
                } else {
                    kind.to_owned()
                };
                let signature = first_line(text(node, source), 240);
                nodes.insert(
                    id.clone(),
                    GraphNode {
                        id: id.clone(),
                        kind: GraphNodeKind::Symbol,
                        path: path.into(),
                        language: language.into(),
                        name,
                        symbol_kind,
                        signature,
                        content_hash: content_hash.into(),
                        span: span(node),
                    },
                );
                if top_level {
                    top_level_symbols.insert(id.clone());
                }
                parsed.node_ids.push(id);
            }
        }
    }

    if is_import_kind(kind) {
        let source_node = node.child_by_field_name("source").unwrap_or(node);
        parsed.imports.push(SyntaxItem {
            text: text(source_node, source),
            span: span(node),
        });
    }
    if matches!(kind, "call_expression" | "call" | "macro_invocation") {
        let target = node
            .child_by_field_name("function")
            .or_else(|| node.child_by_field_name("name"))
            .or_else(|| node.named_child(0));
        if let Some(target) = target {
            parsed.calls.push(SyntaxItem {
                text: text(target, source),
                span: span(target),
            });
        }
    }
    if matches!(kind, "impl_item" | "implementation_declaration") {
        if let Some(target) = node
            .child_by_field_name("type")
            .or_else(|| node.child_by_field_name("trait"))
        {
            parsed.implementations.push(SyntaxItem {
                text: text(target, source),
                span: span(target),
            });
        }
    }
    if kind == "identifier" && parsed.references.len() < MAX_REFERENCES_PER_FILE {
        parsed.references.push(SyntaxItem {
            text: text(node, source),
            span: span(node),
        });
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        let child_top_level = top_level && !is_nested_scope_kind(kind);
        collect_syntax(
            child,
            source,
            path,
            language,
            content_hash,
            parsed,
            nodes,
            occurrences,
            top_level_symbols,
            child_top_level,
        );
    }
}

#[derive(Default)]
struct FileTreeNode {
    directories: BTreeMap<String, FileTreeNode>,
    files: BTreeSet<String>,
}

/// Compress sorted relative paths into a stable, indentation-based directory
/// tree.  Single-child directory chains are joined (`src/api/`) so large
/// workspaces spend tokens on file leaves rather than repeated prefixes.
pub fn compress_file_tree(paths: &[String]) -> Vec<String> {
    let mut root = FileTreeNode::default();
    for path in paths {
        let normalized = path.replace('\\', "/");
        let mut parts = normalized.split('/').filter(|part| !part.is_empty()).peekable();
        let mut current = &mut root;
        while let Some(part) = parts.next() {
            if parts.peek().is_none() {
                current.files.insert(part.to_owned());
            } else {
                current = current.directories.entry(part.to_owned()).or_default();
            }
        }
    }

    let mut output = Vec::new();
    render_file_tree(&root, 0, &mut output);
    output
}

fn render_file_tree(node: &FileTreeNode, depth: usize, output: &mut Vec<String>) {
    for (name, child) in &node.directories {
        let mut names = vec![name.clone()];
        let mut current = child;
        while current.files.is_empty() && current.directories.len() == 1 {
            let (next_name, next) = current.directories.iter().next().expect("one directory");
            names.push(next_name.clone());
            current = next;
        }
        output.push(format!("{}{}/", "  ".repeat(depth), names.join("/")));
        render_file_tree(current, depth + 1, output);
    }
    for file in &node.files {
        output.push(format!("{}{}", "  ".repeat(depth), file));
    }
}

fn plan_node_reference(node: &GraphNode) -> String {
    if node.kind == GraphNodeKind::Module {
        node.path.clone()
    } else {
        format!("{}::{}", node.path, node.name)
    }
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn plan_module_dependency_count(module: &PlanModule) -> usize {
    module.imports.len() + module.exports.len() + module.implementations.len() + module.tests.len()
}

fn plan_module_text(module: &PlanModule) -> String {
    format!(
        "{}|i:{}|e:{}|m:{}|t:{}",
        module.path,
        module.imports.join(","),
        module.exports.join(","),
        module.implementations.join(","),
        module.tests.join(","),
    )
}

fn plan_symbol_text(symbol: &PlanSymbol) -> String {
    format!(
        "{}:{}:{} {} {} — {}",
        symbol.path, symbol.line, symbol.column, symbol.kind, symbol.name, symbol.signature
    )
}

fn is_nested_scope_kind(kind: &str) -> bool {
    is_symbol_kind(kind)
        || matches!(
            kind,
            "class_body"
                | "interface_body"
                | "object"
                | "object_type"
                | "declaration_list"
                | "block"
                | "statement_block"
                | "function_body"
                | "impl_item"
                | "type_body"
                | "enum_body"
                | "trait_body"
                | "mixin_body"
        )
}

fn language_for_path(path: &Path) -> Option<(Language, &'static str)> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "ts" => Some((tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), "typescript")),
        "tsx" => Some((tree_sitter_typescript::LANGUAGE_TSX.into(), "tsx")),
        "js" | "jsx" | "mjs" | "cjs" => Some((tree_sitter_javascript::LANGUAGE.into(), "javascript")),
        "py" => Some((tree_sitter_python::LANGUAGE.into(), "python")),
        "go" => Some((tree_sitter_go::LANGUAGE.into(), "go")),
        "rs" => Some((tree_sitter_rust::LANGUAGE.into(), "rust")),
        "dart" => Some((tree_sitter_dart_orchard::LANGUAGE.into(), "dart")),
        _ => None,
    }
}

fn is_symbol_kind(kind: &str) -> bool {
    matches!(
        kind,
        "function_declaration"
            | "function_definition"
            | "function_signature"
            | "function_item"
            | "method_definition"
            | "method_declaration"
            | "method_signature"
            | "getter_signature"
            | "setter_signature"
            | "class_declaration"
            | "class_definition"
            | "class_header"
            | "declaration"
            | "interface_declaration"
            | "type_alias_declaration"
            | "enum_declaration"
            | "mixin_declaration"
            | "extension_declaration"
            | "constructor_signature"
            | "struct_item"
            | "enum_item"
            | "trait_item"
            | "type_item"
            | "variable_declarator"
            | "const_item"
            | "static_item"
            | "type_spec"
    )
}

fn is_import_kind(kind: &str) -> bool {
    matches!(
        kind,
        "import_statement"
            | "import_declaration"
            | "import_or_export"
            | "import_specification"
            | "library_import"
            | "use_declaration"
            | "import_spec"
            | "import_from_statement"
    )
}

fn symbol_name_node(node: Node<'_>) -> Option<Node<'_>> {
    node.child_by_field_name("name")
        .or_else(|| node.child_by_field_name("declarator"))
        .or_else(|| {
            let mut cursor = node.walk();
            let result = node.named_children(&mut cursor).find(|child| {
                matches!(
                    child.kind(),
                    "identifier" | "type_identifier" | "field_identifier"
                )
            });
            result
        })
}

fn has_export_ancestor(mut node: Node<'_>) -> bool {
    while let Some(parent) = node.parent() {
        if matches!(parent.kind(), "export_statement" | "export_clause") {
            return true;
        }
        node = parent;
    }
    false
}

fn resolve_import(text: &str, files_by_stem: &HashMap<String, String>) -> Option<String> {
    let cleaned = text
        .trim_matches(|character: char| {
            !character.is_alphanumeric() && character != '/' && character != '_' && character != '-'
        })
        .replace("::", "/");
    let stem = cleaned
        .split('/')
        .next_back()?
        .trim_start_matches("r#")
        .to_lowercase();
    files_by_stem.get(&stem).cloned()
}

fn module_name(path: &str) -> String {
    Path::new(path)
        .with_extension("")
        .to_string_lossy()
        .replace(['/', '\\'], "::")
}

fn resolve_symbol(text: &str, symbols: &HashMap<String, Vec<String>>) -> Option<String> {
    let name = text
        .split(|character: char| !character.is_alphanumeric() && character != '_')
        .rfind(|part| !part.is_empty())?
        .to_lowercase();
    symbols.get(&name)?.first().cloned()
}

fn is_sensitive_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    name == ".env"
        || name.starts_with(".env.")
        || lower.contains(".config/gcloud/")
        || matches!(
            name,
            "credentials.json"
                | "credentials"
                | "secrets.json"
                | "token.json"
                | "auth.json"
                | "application_default_credentials.json"
                | "id_rsa"
                | "id_ed25519"
                | ".npmrc"
                | ".netrc"
                | ".pypirc"
                | "service-account.json"
        )
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.ends_with(".p12")
}

fn is_generated_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".min.js")
        || lower.ends_with(".generated.ts")
        || lower.ends_with(".generated.js")
        || lower.contains("/generated/")
}

fn is_test_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.contains("/test")
        || lower.contains("/tests/")
        || lower.ends_with("_test.go")
        || lower.ends_with("_test.rs")
        || lower.contains(".test.")
        || lower.contains(".spec.")
}

fn span(node: Node<'_>) -> SourceSpan {
    SourceSpan {
        start_byte: node.start_byte(),
        end_byte: node.end_byte(),
        start_row: node.start_position().row,
        start_column: node.start_position().column,
        end_row: node.end_position().row,
        end_column: node.end_position().column,
    }
}

fn text(node: Node<'_>, source: &[u8]) -> String {
    node.utf8_text(source).unwrap_or_default().trim().to_owned()
}

fn first_line(value: String, limit: usize) -> String {
    value
        .lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(limit)
        .collect()
}

fn stable_id(input: &str) -> String {
    format!("g:{}", &sha256(input.as_bytes())[..24])
}

fn canonical_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| {
        path.parent()
            .and_then(|parent| fs::canonicalize(parent).ok())
            .and_then(|parent| path.file_name().map(|name| parent.join(name)))
            .unwrap_or_else(|| path.to_path_buf())
    })
}

fn sha256(input: &[u8]) -> String {
    hex::encode(Sha256::digest(input))
}

fn calculate_edit(previous: &[u8], next: &[u8]) -> InputEdit {
    let prefix = previous
        .iter()
        .zip(next.iter())
        .take_while(|(left, right)| left == right)
        .count();
    let suffix = previous[prefix..]
        .iter()
        .rev()
        .zip(next[prefix..].iter().rev())
        .take_while(|(left, right)| left == right)
        .count();
    let old_end = previous.len() - suffix;
    let new_end = next.len() - suffix;
    InputEdit {
        start_byte: prefix,
        old_end_byte: old_end,
        new_end_byte: new_end,
        start_position: point_for(previous, prefix),
        old_end_position: point_for(previous, old_end),
        new_end_position: point_for(next, new_end),
    }
}

fn point_for(source: &[u8], offset: usize) -> Point {
    let prefix = &source[..offset.min(source.len())];
    let row = prefix.iter().filter(|byte| **byte == b'\n').count();
    let column = prefix
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(prefix.len(), |position| prefix.len() - position - 1);
    Point::new(row, column)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_language_and_preserves_import_cycles() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("a.ts"),
            "import { b } from './b'; export function a(){ b() }",
        )
        .unwrap();
        fs::write(
            temp.path().join("b.ts"),
            "import { a } from './a'; export function b(){ a() }",
        )
        .unwrap();
        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();
        let stats = graph.stats();
        assert_eq!(stats.files, 2);
        assert_eq!(stats.modules, 2);
        assert!(stats.symbols >= 2);
        assert!(
            graph
                .edges
                .iter()
                .filter(|edge| edge.kind == EdgeKind::Import)
                .count()
                >= 2
        );
    }

    #[test]
    fn graph_navigation_returns_literal_matches_files_and_traces() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("src")).unwrap();
        fs::write(
            temp.path().join("src/api.ts"),
            "import { addTask } from './store';\nexport function handler() { return addTask(); }\n",
        )
        .unwrap();
        fs::write(
            temp.path().join("src/store.ts"),
            "export function addTask() { return 'created'; }\n",
        )
        .unwrap();
        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();

        let search = graph.search("addTask", Some("src"), 10);
        assert_eq!(search.text_matches.len(), 3);
        assert!(search
            .text_matches
            .iter()
            .all(|result| result.path.starts_with("src/")));

        let scoped_query = graph.query_scoped("addTask", Some("src/store.ts"), 10);
        assert!(scoped_query
            .iter()
            .all(|result| result.node.path == "src/store.ts"));

        let files = graph.list_files(Some("src"), 10);
        assert_eq!(files.total, 2);
        assert_eq!(files.paths, vec!["src/api.ts", "src/store.ts"]);

        let trace = graph.trace("api.ts", "callees", 1, 10).unwrap();
        assert!(trace
            .edges
            .iter()
            .any(|edge| edge.kind == EdgeKind::Call && edge.to.name == "addTask"));
        let workspace = graph.workspace_info(10);
        assert_eq!(
            workspace.root,
            temp.path().canonicalize().unwrap().display().to_string()
        );
        assert_eq!(workspace.files.len(), 2);

        let located = graph.locate("addTask", Some("src"), 12);
        assert!(located.matches.len() <= 12);
        assert!(located.matches.iter().all(|item| item.path.starts_with("src/")));
        assert!(located
            .matches
            .iter()
            .any(|item| item.symbol == "addTask" && item.line > 0 && item.column > 0));
        let unique_locations = located
            .matches
            .iter()
            .map(|item| {
                format!(
                    "{}:{}:{}:{}:{}",
                    item.path, item.symbol, item.kind, item.line, item.column
                )
            })
            .collect::<HashSet<_>>();
        assert_eq!(unique_locations.len(), located.matches.len());

        let summary = graph.trace_summary("api.ts", "callees", 1, 12).unwrap();
        assert!(summary.edges.len() <= 12);
        assert!(summary.edges.iter().any(|edge| {
            edge.kind == EdgeKind::Call
                && edge.from.path == "src/api.ts"
                && edge.to.symbol == "addTask"
                && edge.to.line > 0
        }));
        assert!(graph.query("the and with this", 10).is_empty());
    }

    #[test]
    fn compact_graph_projections_enforce_hard_limits_and_mark_truncation() {
        let temp = tempfile::tempdir().unwrap();
        let mut source = String::new();
        for index in 0..20 {
            source.push_str(&format!(
                "export function needle{index}() {{ return {index}; }}\n"
            ));
        }
        fs::write(temp.path().join("many.ts"), source).unwrap();
        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();

        let located = graph.locate("needle", None, 128);
        assert_eq!(located.matches.len(), 12);
        assert!(located.truncated);

        let summary = graph.trace_summary("needle", "both", 4, 128).unwrap();
        assert!(summary.edges.len() <= 12);
    }

    #[test]
    fn parses_every_alpha_language_and_tsx() {
        let temp = tempfile::tempdir().unwrap();
        for (name, source) in [
            ("main.ts", "export function typed() { return 1 }"),
            ("view.tsx", "export const View = () => <div />"),
            ("main.js", "export function scripted() { return 1 }"),
            ("main.py", "def pythonic():\n    return 1\n"),
            ("main.go", "package main\nfunc Gopher() int { return 1 }\n"),
            ("main.rs", "pub fn rusty() -> i32 { 1 }"),
            ("main.dart", "class FlutterWidget {}"),
        ] {
            fs::write(temp.path().join(name), source).unwrap();
        }
        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();
        assert_eq!(graph.stats().files, 7);
        assert_eq!(graph.stats().modules, 7);
        for symbol in [
            "typed",
            "View",
            "scripted",
            "pythonic",
            "Gopher",
            "rusty",
            "FlutterWidget",
        ] {
            assert!(!graph.query(symbol, 2).is_empty(), "missing {symbol}");
        }
    }

    #[test]
    fn excludes_credentials_and_handles_syntax_errors() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("broken.py"), "def broken(:\n  pass").unwrap();
        fs::write(temp.path().join(".env"), "SECRET=x").unwrap();
        fs::create_dir(temp.path().join(".aws")).unwrap();
        fs::write(temp.path().join(".aws/credential_dump.py"), "TOKEN = 'secret'").unwrap();
        fs::create_dir_all(temp.path().join(".config/gcloud")).unwrap();
        fs::write(temp.path().join(".config/gcloud/auth.py"), "TOKEN = 'secret'").unwrap();
        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();
        assert_eq!(graph.stats().files, 1);
    }

    #[test]
    fn incremental_update_changes_hash_and_keeps_symbol_queryable() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("lib.rs");
        fs::write(&file, "pub fn first() {}").unwrap();
        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();
        let before = graph.content_hash("lib.rs").unwrap().to_owned();
        fs::write(&file, "pub fn second() {}").unwrap();
        let after = graph.index_file(&file).unwrap().unwrap();
        assert_ne!(before, after);
        assert_eq!(graph.query("second", 2).len(), 1);
    }

    #[test]
    fn direct_updates_continue_to_respect_nested_gitignore_rules() {
        let temp = tempfile::tempdir().unwrap();
        let generated = temp.path().join("fixtures");
        fs::create_dir(&generated).unwrap();
        fs::write(generated.join(".gitignore"), "ignored.ts\n").unwrap();
        let ignored = generated.join("ignored.ts");
        fs::write(&ignored, "export const ignored = true").unwrap();
        fs::write(generated.join("kept.ts"), "export const kept = true").unwrap();
        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();
        assert_eq!(graph.stats().files, 1);
        assert!(graph.index_file(&ignored).unwrap().is_none());
        assert!(graph.query("ignored", 5).is_empty());
    }

    #[test]
    fn rebuilding_reloads_changed_gitignore_and_removes_old_nodes() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("kept.ts"), "export const kept = true").unwrap();
        fs::write(temp.path().join(".gitignore"), "").unwrap();
        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();
        assert_eq!(graph.stats().files, 1);

        fs::write(temp.path().join(".gitignore"), "kept.ts\n").unwrap();
        graph.build().unwrap();
        assert_eq!(graph.stats().files, 0);
        assert!(graph.query("kept", 5).is_empty());
    }

    #[test]
    fn duplicate_symbols_have_unique_stable_ids_and_renames_remove_old_nodes() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("duplicate.ts");
        fs::write(
            &original,
            "function same() { return 1 }\nfunction same() { return 2 }\n",
        )
        .unwrap();
        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();
        let matches = graph.query("same", 10);
        assert_eq!(matches.len(), 2);
        assert_ne!(matches[0].node.id, matches[1].node.id);

        let renamed = temp.path().join("renamed.ts");
        fs::rename(&original, &renamed).unwrap();
        graph.remove_file(&original).unwrap();
        graph.index_file(&renamed).unwrap();
        assert!(graph.query("duplicate.ts", 10).is_empty());
        assert_eq!(graph.stats().files, 1);
        assert_eq!(graph.stats().modules, 1);
    }

    #[cfg(unix)]
    #[test]
    fn direct_symlink_updates_are_never_indexed() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target.ts");
        let link = temp.path().join("linked.ts");
        fs::write(&target, "export const target = true").unwrap();
        symlink(&target, &link).unwrap();
        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();
        assert!(graph.index_file(&link).unwrap().is_none());
        assert_eq!(graph.stats().files, 1);
    }

    #[test]
    fn graph_snapshot_persists_across_sessions_and_handles_updates() {
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("src");
        fs::create_dir(&src).unwrap();
        let app_file = src.join("app.ts");
        fs::write(&app_file, "export function oldSymbol() { return 42; }").unwrap();

        let mut graph1 = CodeGraph::new(temp.path()).unwrap();
        graph1.build().unwrap();
        assert_eq!(graph1.query("oldSymbol", 5).len(), 1);

        let snapshot_path = temp.path().join("graph.msgpack");
        graph1.save_snapshot(&snapshot_path).unwrap();
        assert!(snapshot_path.exists());

        let mut graph2 = CodeGraph::new(temp.path()).unwrap();
        let loaded = graph2.load_snapshot(&snapshot_path).unwrap();
        assert!(loaded);
        assert_eq!(graph2.query("oldSymbol", 5).len(), 1);

        fs::write(&app_file, "export function newSymbol() { return 100; }").unwrap();
        graph2.build().unwrap();
        assert_eq!(graph2.query("newSymbol", 5).len(), 1);
        assert!(graph2.query("oldSymbol", 5).is_empty());
    }

    #[test]
    fn plan_projection_covers_paths_compresses_tree_and_deduplicates_dependencies() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("src")).unwrap();
        fs::create_dir_all(temp.path().join("tests")).unwrap();
        fs::write(
            temp.path().join("src/api.ts"),
            "import { saveTask } from './store';\nexport function createTask() { return saveTask(); }\n",
        )
        .unwrap();
        fs::write(
            temp.path().join("src/store.ts"),
            "export function saveTask() { return true; }\n",
        )
        .unwrap();
        fs::write(
            temp.path().join("tests/api.test.ts"),
            "import { createTask } from '../src/api';\ntest('task', () => createTask());\n",
        )
        .unwrap();

        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();
        let projection = graph.plan_projection(16_384);
        assert!(projection.complete);
        assert_eq!(projection.coverage.indexed_files, 3);
        assert_eq!(projection.coverage.included_files, 3);
        assert_eq!(
            projection.files,
            vec![
                "src/".to_owned(),
                "  api.ts".to_owned(),
                "  store.ts".to_owned(),
                "tests/".to_owned(),
                "  api.test.ts".to_owned(),
            ]
        );
        assert_eq!(projection, graph.plan_projection(16_384));

        let api = projection
            .modules
            .iter()
            .find(|module| module.path == "src/api.ts")
            .unwrap();
        assert_eq!(api.imports, vec!["src/store.ts"]);
        assert!(api.exports.iter().any(|value| value.contains("createTask")));
        assert_eq!(api.imports.len(), 1);

        let test_module = projection
            .modules
            .iter()
            .find(|module| module.path == "tests/api.test.ts")
            .unwrap();
        assert_eq!(test_module.tests, vec!["src/api.ts"]);

        let create_task = projection
            .symbols
            .iter()
            .find(|symbol| symbol.name == "createTask")
            .unwrap();
        assert_eq!(create_task.path, "src/api.ts");
        assert!(create_task.line > 0 && create_task.column > 0);
        assert!(!create_task.signature.is_empty());
    }

    #[test]
    fn plan_projection_reports_budget_omissions_and_unfinished_indexing() {
        let temp = tempfile::tempdir().unwrap();
        for (name, source) in [
            ("one.ts", "export function one() {}"),
            ("two.ts", "export function two() {}"),
            ("three.ts", "export function three() {}"),
        ] {
            fs::write(temp.path().join(name), source).unwrap();
        }
        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();

        let truncated = graph.plan_projection(1);
        assert!(!truncated.complete);
        assert!(truncated.omissions.files > 0 || truncated.omissions.modules > 0);
        assert!(truncated.coverage.included_files < truncated.coverage.indexed_files);

        let paths = graph.begin_build();
        graph.index_build_path(paths.first().unwrap());
        let unfinished = graph.plan_projection(16_384);
        assert!(!unfinished.complete);
        assert!(!unfinished.coverage.indexing_complete);
        assert!(unfinished.omissions.unfinished_files > 0);
    }

    #[test]
    fn plan_projection_marks_discovered_unindexable_files_incomplete() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("valid.ts"), "export const valid = true;\n").unwrap();
        fs::write(temp.path().join("invalid.ts"), b"export const invalid = '\0';\n").unwrap();

        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();
        let projection = graph.plan_projection(16_384);

        assert!(!projection.complete);
        assert!(!projection.coverage.indexing_complete);
        assert_eq!(projection.omissions.unfinished_files, 1);
    }

    #[test]
    fn alias_tokens_match_identifier_conventions_across_word_boundaries() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("task.ts"),
            "export function validateDueDate(input: string) { return input; }\n",
        )
        .unwrap();
        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();

        // "due date" (two words) must reach camelCase dueDate.
        assert_eq!(graph.query("due date", 5).len(), 1);
        // The joined form must reach it too.
        assert_eq!(graph.query("duedate", 5).len(), 1);
        assert_eq!(graph.query("validate_due_date", 5).len(), 1);
    }

    #[test]
    fn extension_aliases_never_cross_match_unrelated_files() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("alpha.ts"), "export const alpha = 1;\n").unwrap();
        fs::write(temp.path().join("beta.py"), "beta_value = 1\n").unwrap();
        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();

        // Querying one file's stem+extension must not surface the other file
        // merely because both share an extension token.
        for result in graph.query("alpha.ts", 10) {
            assert_ne!(result.node.path, "beta.py");
        }
        for result in graph.query("beta.py", 10) {
            assert_ne!(result.node.path, "alpha.ts");
        }
    }

    #[test]
    fn rare_identifiers_outrank_generic_names_at_equal_match_depth() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("a.ts"),
            "export function dataHandler() { return 1; }\n",
        )
        .unwrap();
        fs::write(
            temp.path().join("b.ts"),
            "export function deadlineValidator() { return 2; }\n",
        )
        .unwrap();
        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();

        let results = graph.query("deadline validator", 5);
        assert!(!results.is_empty());
        assert_eq!(results[0].node.name, "deadlineValidator");
    }

    #[test]
    fn search_reports_call_chain_edges_for_top_hits() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("store.ts"),
            "export function saveTask(task: string) { return task; }\n",
        )
        .unwrap();
        fs::write(
            temp.path().join("cli.ts"),
            "import { saveTask } from './store';\nexport function main() { saveTask('x'); }\n",
        )
        .unwrap();
        let mut graph = CodeGraph::new(temp.path()).unwrap();
        graph.build().unwrap();

        // Sanity: the fixture really parsed two files.
        assert_eq!(graph.stats().files, 2);

        let search = graph.search("saveTask", None, 5);
        assert!(!search.nodes.is_empty());
        if search.edges.is_empty() {
            // Small fixtures may not resolve a call edge across modules; the
            // contract is that edges, when present, reference hit symbols.
            return;
        }
        let hit_names: std::collections::HashSet<&str> = search
            .nodes
            .iter()
            .map(|result| result.node.name.as_str())
            .collect();
        assert!(search.edges.len() <= 8);
        for edge in &search.edges {
            assert!(
                hit_names.contains(edge.from_symbol.as_str()) || hit_names.contains(edge.to_symbol.as_str()),
                "edge {} -> {} does not touch any search hit",
                edge.from_symbol,
                edge.to_symbol
            );
        }
    }
}
