use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
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
    pub base_hash: String,
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
    pub base_hash: String,
    pub staged_hash: String,
    pub supported: bool,
    pub syntax_ok: bool,
    pub diagnostics: Vec<ParseDiagnostic>,
    pub diagnostics_truncated: bool,
}

pub fn resolve_edit_targets(root: &Path, input: ResolveEditTargetsInput) -> Result<ResolveEditTargetsOutput> {
    let path = resolve_workspace_file(root, &input.path, true)?;
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
    Ok(ResolveEditTargetsOutput {
        path: relative,
        language: language_name.into(),
        base_hash,
        matches: candidates,
        truncated,
    })
}

pub fn parse_staged(root: &Path, input: StagedParseInput) -> Result<StagedParseOutput> {
    let path = resolve_workspace_file(root, &input.path, true)?;
    let current = fs::read(&path)?;
    let current_hash = sha256(&current);
    if current_hash != input.base_hash {
        return Err(anyhow!("stale file hash for {}", input.path));
    }
    let staged = input.content.into_bytes();
    if staged.len() as u64 > MAX_FILE_BYTES {
        return Err(anyhow!("staged file exceeds {MAX_FILE_BYTES} byte parse limit"));
    }
    let Some((language, language_name)) = language_for_path(&path) else {
        return Ok(StagedParseOutput {
            path: project_relative(root, &path)?,
            language: "unsupported".into(),
            base_hash: current_hash,
            staged_hash: sha256(&staged),
            supported: false,
            syntax_ok: true,
            diagnostics: Vec::new(),
            diagnostics_truncated: false,
        });
    };
    let mut parser = Parser::new();
    parser.set_language(&language)?;
    let tree = parser.parse(&staged, None).context("Tree-sitter staged parse failed")?;
    let mut diagnostics = Vec::new();
    collect_error_nodes(tree.root_node(), &mut diagnostics);
    let diagnostics_truncated = diagnostics.len() > MAX_PARSE_ERRORS;
    diagnostics.truncate(MAX_PARSE_ERRORS);
    Ok(StagedParseOutput {
        path: project_relative(root, &path)?,
        language: language_name.into(),
        base_hash: current_hash,
        staged_hash: sha256(&staged),
        supported: true,
        syntax_ok: !tree.root_node().has_error(),
        diagnostics,
        diagnostics_truncated,
    })
}

fn collect_targets(
    node: Node<'_>,
    source: &[u8],
    query: &str,
    path: &str,
    language: &str,
    base_hash: &str,
    output: &mut Vec<EditTargetRef>,
) {
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

fn push_target(
    node: Node<'_>,
    source: &[u8],
    path: &str,
    language: &str,
    base_hash: &str,
    symbol: String,
    kind: &str,
    output: &mut Vec<EditTargetRef>,
) {
    let start = node.start_byte();
    let end = node.end_byte();
    if end < start || end > source.len() || end.saturating_sub(start) > MAX_TARGET_SOURCE_BYTES {
        return;
    }
    let expected_source = String::from_utf8_lossy(&source[start..end]).into_owned();
    let target_id = target_id(path, base_hash, kind, start, end, &expected_source);
    output.push(EditTargetRef {
        target_id,
        path: path.into(),
        language: language.into(),
        symbol,
        kind: kind.into(),
        base_hash: base_hash.into(),
        start_byte: start,
        end_byte: end,
        start_row: node.start_position().row,
        start_column: node.start_position().column,
        end_row: node.end_position().row,
        end_column: node.end_position().column,
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
            start_byte: node.start_byte(),
            end_byte: node.end_byte(),
            start_row: node.start_position().row,
            start_column: node.start_position().column,
            end_row: node.end_position().row,
            end_column: node.end_position().column,
        });
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.has_error() || child.is_error() || child.is_missing() {
            collect_error_nodes(child, output);
        }
    }
}

fn resolve_workspace_file(root: &Path, requested: &str, must_exist: bool) -> Result<PathBuf> {
    let root = fs::canonicalize(root).context("canonicalize project root")?;
    let requested_path = Path::new(requested);
    if requested_path.is_absolute() || requested.contains('\0') {
        return Err(anyhow!("path must be project-relative"));
    }
    let candidate = root.join(requested_path);
    let resolved = if must_exist {
        fs::canonicalize(&candidate).with_context(|| format!("resolve {}", requested))?
    } else {
        let parent = candidate.parent().ok_or_else(|| anyhow!("path has no parent"))?;
        let parent = fs::canonicalize(parent).context("canonicalize target parent")?;
        parent.join(candidate.file_name().ok_or_else(|| anyhow!("path has no filename"))?)
    };
    if !resolved.starts_with(&root) {
        return Err(anyhow!("path escapes project root"));
    }
    let metadata = fs::symlink_metadata(&resolved)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(anyhow!("path is not a regular project file"));
    }
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
    node.child_by_field_name("name")
        .or_else(|| node.child_by_field_name("declarator"))
        .or_else(|| {
            let mut cursor = node.walk();
            node.named_children(&mut cursor).find(|child| {
                matches!(child.kind(), "identifier" | "type_identifier" | "field_identifier")
            })
        })
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

fn node_text(node: Node<'_>, source: &[u8]) -> String {
    node.utf8_text(source).unwrap_or_default().trim().to_owned()
}

fn sha256(input: &[u8]) -> String {
    hex::encode(Sha256::digest(input))
}

fn default_target_limit() -> usize { 12 }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_revision_bound_targets_with_utf8_byte_offsets() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("mod.ts"), "const π = 3;\nexport function hello() { return π; }\n").unwrap();
        let output = resolve_edit_targets(temp.path(), ResolveEditTargetsInput {
            path: "mod.ts".into(), query: "hello".into(), expected_hash: None, limit: 12,
        }).unwrap();
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
        let output = resolve_edit_targets(temp.path(), ResolveEditTargetsInput {
            path: "dup.ts".into(), query: "same".into(), expected_hash: None, limit: 12,
        }).unwrap();
        assert_eq!(output.matches.len(), 2);
        assert_ne!(output.matches[0].target_id, output.matches[1].target_id);
    }

    #[test]
    fn stale_hash_and_new_syntax_errors_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("x.ts"), "export function x(){ return 1 }\r\n").unwrap();
        let resolved = resolve_edit_targets(temp.path(), ResolveEditTargetsInput {
            path: "x.ts".into(), query: "x".into(), expected_hash: None, limit: 12,
        }).unwrap();
        assert!(resolve_edit_targets(temp.path(), ResolveEditTargetsInput {
            path: "x.ts".into(), query: "x".into(), expected_hash: Some("bad".into()), limit: 12,
        }).is_err());
        let parsed = parse_staged(temp.path(), StagedParseInput {
            path: "x.ts".into(), base_hash: resolved.base_hash, content: "export function x( {".into(),
        }).unwrap();
        assert!(parsed.supported);
        assert!(!parsed.syntax_ok);
        assert!(!parsed.diagnostics.is_empty());
    }
}
