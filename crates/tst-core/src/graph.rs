use anyhow::{Context, Result};
use ignore::gitignore::Gitignore;
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
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

#[derive(Clone, Debug, Serialize)]
pub struct GraphQueryResult {
    pub node: GraphNode,
    pub score: u32,
}

#[derive(Default)]
struct ParsedFile {
    node_ids: Vec<String>,
    imports: Vec<SyntaxItem>,
    calls: Vec<SyntaxItem>,
    references: Vec<SyntaxItem>,
    implementations: Vec<SyntaxItem>,
}

#[derive(Clone)]
struct SyntaxItem {
    text: String,
    span: SourceSpan,
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
        })
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
        self.nodes.clear();
        self.edges.clear();
        self.files.clear();
        self.trees.clear();
        self.sources.clear();
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
            Ok(_) => self.progress.indexed += 1,
            Err(_) => self.progress.skipped += 1,
        }
    }

    pub fn finish_build(&mut self) {
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
        let terms: Vec<String> = query
            .to_lowercase()
            .split_whitespace()
            .map(ToOwned::to_owned)
            .collect();

        // Identify spatio-temporal active paths from query terms or known graph files
        let mut active_paths = HashSet::new();
        for term in &terms {
            let clean = term.trim_matches(|c: char| !c.is_alphanumeric() && c != '/' && c != '.' && c != '_');
            if clean.contains('/') || clean.contains('.') {
                for file_path in self.files.keys() {
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

        let mut matches = Vec::new();
        for node in self.nodes.values() {
            let mut score = 0;
            let path = node.path.to_lowercase();
            let name = node.name.to_lowercase();
            let signature = node.signature.to_lowercase();

            // Spatio-temporal locality boost
            if active_paths.contains(&path) {
                score += 50;
            } else if neighbor_node_ids.contains(&node.id) {
                score += 20;
            }

            for term in &terms {
                let clean_term = term.trim_matches(|c: char| !c.is_alphanumeric() && c != '/' && c != '.' && c != '_');
                if clean_term.is_empty() {
                    continue;
                }
                if name == clean_term {
                    score += 20;
                } else if name.contains(clean_term) {
                    score += 10;
                }
                if path.contains(clean_term) {
                    score += 6;
                }
                if signature.contains(clean_term) {
                    score += 2;
                }
            }

            if score > 0 {
                matches.push(GraphQueryResult {
                    node: node.clone(),
                    score,
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
        collect_syntax(
            child,
            source,
            path,
            language,
            content_hash,
            parsed,
            nodes,
            occurrences,
        );
    }
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
        for symbol in ["typed", "View", "scripted", "pythonic", "Gopher", "rusty", "FlutterWidget"] {
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
}
