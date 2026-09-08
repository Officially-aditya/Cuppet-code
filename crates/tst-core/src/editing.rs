use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tree_sitter::{Language, Node, Parser};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TARGET_SOURCE_BYTES: usize = 64 * 1024;
const MAX_PARSE_ERRORS: usize = 64;

#[derive(Clone, Debug, Deserialize)]
pub struct ResolveEditTargetsInput {
    pub path: String,
    pub query: String,
    #[serde(default)]
    pub expected_hash: Option<String>,
    #[serde(default = "default_target_limit")]
    pub limit: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct EditTargetRef {
    pub target_id: String,
    pub path: String,
    pub language: String,
    pub symbol: String,
    pub kind: String,
    pub base_hash: String,
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_row: usize,
    pub start_column: usize,
    pub end_row: usize,
    pub end_column: usize,
    pub expected_source: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ResolveEditTargetsOutput {
    pub path: String,
    pub language: String,
    pub base_hash: String,
    pub matches: Vec<EditTargetRef>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct StagedParseInput {
    pub path: String,
    #[serde(default)]
    pub base_hash: Option<String>,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ParseDiagnostic {
    pub kind: String,
    pub start_byte: usize,
    pub end_byte: usize,
    pub start_row: usize,
    pub start_column: usize,
    pub end_row: usize,
    pub end_column: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct StagedParseOutput {
    pub path: String,
    pub language: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_hash: Option<String>,
    pub staged_hash: String,
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_syntax_ok: Option<bool>,
    pub staged_syntax_ok: bool,
    pub introduced_syntax_errors: usize,
    pub base_diagnostics: Vec<ParseDiagnostic>,
    pub staged_diagnostics: Vec<ParseDiagnostic>,
    pub diagnostics_truncated: bool,
}

pub fn resolve_edit_targets(root: &Path, input: ResolveEditTargetsInput) -> Result<ResolveEditTargetsOutput> {
    let path = resolve_workspace_path(root, &input.path, true)?;
    let source = fs::read(&path)?;
    if source.len() as u64 > MAX_FILE_BYTES {
        return Err(anyhow!("file exceeds {MAX_FILE_BYTES} byte edit-target limit"));
    }
    if source.contains(&0) {
        return Err(anyhow!("binary files cannot be structurally edited"));
    }
    let base_hash = sha256(&source);
    if input.expected_hash.as_deref().is_some_and(|expected| expected != base_hash) {
        return Err(anyhow!("stale file hash for {}", input.path));
    }
    let (language, language_name) = language_for_path(&path)
        .ok_or_else(|| anyhow!("unsupported staged-parse language for {}", input.path))?;
    let mut parser = Parser::new();
    parser.set_language(&language)?;
    let tree = parser.parse(&source, None).context("Tree-sitter parse failed")?;

    let query = input.query.trim();
    if query.is_empty() {
        return Err(anyhow!("query is required"));
    }
    let limit = input.limit.clamp(1, 64);
    let relative = project_relative(root, &path)?;
    let mut candidates = Vec::new();
    collect_targets(tree.root_node(), &source, query, &relative, language_name, &base_hash, &mut candidates);
    candidates.sort_by(|left, right| {
        target_rank(left, query)
            .cmp(&target_rank(right, query))
            .then_with(|| left.start_byte.cmp(&right.start_byte))
            .then_with(|| left.kind.cmp(&right.kind))
    });
    candidates.dedup_by(|left, right| left.start_byte == right.start_byte && left.end_byte == right.end_byte && left.kind == right.kind);
    let truncated = candidates.len() > limit;
    candidates.truncate(limit);
    Ok(ResolveEditTargetsOutput { path: relative, language: language_name.into(), base_hash, matches: candidates, truncated })
}

pub fn parse_staged(root: &Path, input: StagedParseInput) -> Result<StagedParseOutput> {
    let path = resolve_workspace_path(root, &input.path, input.base_hash.is_some())?;
    let relative = project_relative(root, &path)?;
    let current = if input.base_hash.is_some() { Some(fs::read(&path)?) } else { None };
    let current_hash = current.as_ref().map(|value| sha256(value));
    if input.base_hash.as_deref() != current_hash.as_deref() {
        return Err(anyhow!("stale file hash for {}", input.path));
    }
    let staged = input.content.into_bytes();
    if staged.len() as u64 > MAX_FILE_BYTES {
        return Err(anyhow!("staged file exceeds {MAX_FILE_BYTES} byte parse limit"));
    }
    if staged.contains(&0) {
        return Err(anyhow!("binary staged content is unsupported"));
    }
    let Some((language, language_name)) = language_for_path(&path) else {
        return Ok(StagedParseOutput {
            path: relative,
            language: "unsupported".into(),
            base_hash: current_hash,
            staged_hash: sha256(&staged),
            supported: false,
            base_syntax_ok: None,
            staged_syntax_ok: true,
            introduced_syntax_errors: 0,
            base_diagnostics: Vec::new(),
            staged_diagnostics: Vec::new(),
            diagnostics_truncated: false,
        });
    };

    let (base_syntax_ok, mut base_diagnostics) = if let Some(current) = current.as_ref() {
        let tree = parse_source(&language, current)?;
        let mut diagnostics = Vec::new();
        collect_error_nodes(tree.root_node(), &mut diagnostics);
        (Some(!tree.root_node().has_error()), diagnostics)
    } else {
        (None, Vec::new())
    };
    let staged_tree = parse_source(&language, &staged)?;
    let mut staged_diagnostics = Vec::new();
    collect_error_nodes(staged_tree.root_node(), &mut staged_diagnostics);
    let introduced_syntax_errors = staged_diagnostics.len().saturating_sub(base_diagnostics.len());
    let diagnostics_truncated = base_diagnostics.len() > MAX_PARSE_ERRORS || staged_diagnostics.len() > MAX_PARSE_ERRORS;
    base_diagnostics.truncate(MAX_PARSE_ERRORS);
    staged_diagnostics.truncate(MAX_PARSE_ERRORS);

    Ok(StagedParseOutput {
        path: relative,
        language: language_name.into(),
        base_hash: current_hash,
        staged_hash: sha256(&staged),
        supported: true,
        base_syntax_ok,
        staged_syntax_ok: !staged_tree.root_node().has_error(),
        introduced_syntax_errors,
        base_diagnostics,
        staged_diagnostics,
        diagnostics_truncated,
    })
}

fn parse_source(language: &Language, source: &[u8]) -> Result<tree_sitter::Tree> {
    let mut parser = Parser::new();
    parser.set_language(language)?;
    parser.parse(source, None).context("Tree-sitter parse failed")
}

fn collect_targets(node: Node<'_>, source: &[u8], query: &str, path: &str, language: &str, base_hash: &str, output: &mut Vec<EditTargetRef>) {
    if is_symbol_kind(node.kind()) {
        if let Some(name_node) = symbol_name_node(node) {
            let symbol = node_text(name_node, source);
            if symbol_matches(&symbol, query) {
                push_target(node, source, path, language, base_hash, symbol, node.kind(), output);
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_targets(child, source, query, path, language, base_hash, output);
    }
}

fn push_target(node: Node<'_>, source: &[u8], path: &str, language: &str, base_hash: &str, symbol: String, kind: &str, output: &mut Vec<EditTargetRef>) {
    let start = node.start_byte();
    let end = node.end_byte();
    if end < start || end > source.len() || end.saturating_sub(start) > MAX_TARGET_SOURCE_BYTES { return; }
    let expected_source = String::from_utf8_lossy(&source[start..end]).into_owned();
    let target_id = target_id(path, base_hash, kind, start, end, &expected_source);
    output.push(EditTargetRef {
        target_id, path: path.into(), language: language.into(), symbol, kind: kind.into(), base_hash: base_hash.into(),
        start_byte: start, end_byte: end,
        start_row: node.start_position().row, start_column: node.start_position().column,
        end_row: node.end_position().row, end_column: node.end_position().column,
        expected_source,
    });
}

fn target_id(path: &str, base_hash: &str, kind: &str, start: usize, end: usize, expected_source: &str) -> String {
    let material = format!("{path}\0{base_hash}\0{kind}\0{start}\0{end}\0{expected_source}");
    format!("tst:{}", &sha256(material.as_bytes())[..32])
}

fn target_rank(target: &EditTargetRef, query: &str) -> (u8, usize, usize) {
    let exact = if target.symbol == query { 0 } else if target.symbol.eq_ignore_ascii_case(query) { 1 } else { 2 };
    (exact, target.symbol.len(), target.start_byte)
}

fn symbol_matches(symbol: &str, query: &str) -> bool {
    symbol == query || symbol.eq_ignore_ascii_case(query) || symbol.to_lowercase().contains(&query.to_lowercase())
}

fn collect_error_nodes(node: Node<'_>, output: &mut Vec<ParseDiagnostic>) {
    if node.is_error() || node.is_missing() {
        output.push(ParseDiagnostic {
            kind: if node.is_missing() { format!("missing:{}", node.kind()) } else { node.kind().into() },
            start_byte: node.start_byte(), end_byte: node.end_byte(),
            start_row: node.start_position().row, start_column: node.start_position().column,
            end_row: node.end_position().row, end_column: node.end_position().column,
        });
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.has_error() || child.is_error() || child.is_missing() { collect_error_nodes(child, output); }
    }
}

fn resolve_workspace_path(root: &Path, requested: &str, must_exist: bool) -> Result<PathBuf> {
    let root = fs::canonicalize(root).context("canonicalize project root")?;
    let requested_path = Path::new(requested);
    if requested_path.is_absolute() || requested.contains('\0') || requested_path.components().any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
        return Err(anyhow!("path must stay inside the project root"));
    }
    let candidate = root.join(requested_path);
    let resolved = if must_exist {
        let resolved = fs::canonicalize(&candidate).with_context(|| format!("resolve {}", requested))?;
        let metadata = fs::symlink_metadata(&resolved)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() { return Err(anyhow!("path is not a regular project file")); }
        resolved
    } else {
        if candidate.exists() { return Err(anyhow!("new staged file already exists: {}", requested)); }
        let mut ancestor = candidate.parent().ok_or_else(|| anyhow!("path has no parent"))?.to_path_buf();
        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or_else(|| anyhow!("no existing project ancestor for {}", requested))?.to_path_buf();
        }
        let actual_ancestor = fs::canonicalize(&ancestor)?;
        if !actual_ancestor.starts_with(&root) { return Err(anyhow!("path escapes project root")); }
        candidate
    };
    if !resolved.starts_with(&root) { return Err(anyhow!("path escapes project root")); }
    Ok(resolved)
}

fn project_relative(root: &Path, path: &Path) -> Result<String> {
    let root = fs::canonicalize(root)?;
    Ok(path.strip_prefix(&root)?.to_string_lossy().replace('\\', "/"))
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

fn symbol_name_node(node: Node<'_>) -> Option<Node<'_>> {
    node.child_by_field_name("name").or_else(|| node.child_by_field_name("declarator")).or_else(|| {
        let mut cursor = node.walk();
        node.named_children(&mut cursor).find(|child| matches!(child.kind(), "identifier" | "type_identifier" | "field_identifier"))
    })
}

fn is_symbol_kind(kind: &str) -> bool {
    matches!(kind,
        "function_declaration" | "function_definition" | "function_signature" | "function_item" |
        "method_definition" | "method_declaration" | "method_signature" | "getter_signature" | "setter_signature" |
        "class_declaration" | "class_definition" | "class_header" | "declaration" | "interface_declaration" |
        "type_alias_declaration" | "enum_declaration" | "mixin_declaration" | "extension_declaration" |
        "constructor_signature" | "struct_item" | "enum_item" | "trait_item" | "type_item" |
        "variable_declarator" | "const_item" | "static_item" | "type_spec"
    )
}

fn node_text(node: Node<'_>, source: &[u8]) -> String { node.utf8_text(source).unwrap_or_default().trim().to_owned() }
fn sha256(input: &[u8]) -> String { hex::encode(Sha256::digest(input)) }
fn default_target_limit() -> usize { 12 }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_revision_bound_targets_with_utf8_byte_offsets() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("mod.ts"), "const π = 3;\nexport function hello() { return π; }\n").unwrap();
        let output = resolve_edit_targets(temp.path(), ResolveEditTargetsInput { path: "mod.ts".into(), query: "hello".into(), expected_hash: None, limit: 12 }).unwrap();
        assert_eq!(output.matches.len(), 1);
        let target = &output.matches[0];
        let raw = fs::read(temp.path().join("mod.ts")).unwrap();
        assert_eq!(&raw[target.start_byte..target.end_byte], target.expected_source.as_bytes());
        assert!(target.target_id.starts_with("tst:"));
    }

    #[test]
    fn duplicate_symbols_are_returned_as_distinct_anchors() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("dup.ts"), "function same(){return 1}\nfunction same(){return 2}\n").unwrap();
        let output = resolve_edit_targets(temp.path(), ResolveEditTargetsInput { path: "dup.ts".into(), query: "same".into(), expected_hash: None, limit: 12 }).unwrap();
        assert_eq!(output.matches.len(), 2);
        assert_ne!(output.matches[0].target_id, output.matches[1].target_id);
    }

    #[test]
    fn stale_hash_and_introduced_syntax_errors_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("x.ts"), "export function x(){ return 1 }\r\n").unwrap();
        let resolved = resolve_edit_targets(temp.path(), ResolveEditTargetsInput { path: "x.ts".into(), query: "x".into(), expected_hash: None, limit: 12 }).unwrap();
        assert!(resolve_edit_targets(temp.path(), ResolveEditTargetsInput { path: "x.ts".into(), query: "x".into(), expected_hash: Some("bad".into()), limit: 12 }).is_err());
        let parsed = parse_staged(temp.path(), StagedParseInput { path: "x.ts".into(), base_hash: Some(resolved.base_hash), content: "export function x( {".into() }).unwrap();
        assert!(parsed.supported);
        assert_eq!(parsed.base_syntax_ok, Some(true));
        assert!(parsed.introduced_syntax_errors > 0);
        assert!(!parsed.staged_syntax_ok);
    }

    #[test]
    fn existing_errors_are_separate_and_new_files_can_be_parsed() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("broken.ts"), "export function broken( {").unwrap();
        let hash = sha256(&fs::read(temp.path().join("broken.ts")).unwrap());
        let same = parse_staged(temp.path(), StagedParseInput { path: "broken.ts".into(), base_hash: Some(hash), content: "export function broken( {".into() }).unwrap();
        assert_eq!(same.introduced_syntax_errors, 0);
        let created = parse_staged(temp.path(), StagedParseInput { path: "new.ts".into(), base_hash: None, content: "export const ok = 1;\n".into() }).unwrap();
        assert!(created.supported);
        assert_eq!(created.base_syntax_ok, None);
        assert!(created.staged_syntax_ok);
        assert_eq!(created.introduced_syntax_errors, 0);
    }
}
