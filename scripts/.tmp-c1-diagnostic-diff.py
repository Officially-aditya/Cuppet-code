from pathlib import Path

path = Path('crates/tst-core/src/editing.rs')
text = path.read_text()

replacements = [
    (
        'use std::fs;\nuse std::path::{Component, Path, PathBuf};',
        'use std::collections::HashMap;\nuse std::fs;\nuse std::path::{Component, Path, PathBuf};',
        'HashMap import',
    ),
    (
        '    let introduced_syntax_errors = staged_diagnostics.len().saturating_sub(base_diagnostics.len());\n',
        '    let introduced_syntax_errors = introduced_diagnostic_count(\n        &base_diagnostics,\n        current.as_deref().unwrap_or_default(),\n        &staged_diagnostics,\n        &staged,\n    );\n',
        'introduced syntax error calculation',
    ),
    (
        '''fn collect_error_nodes(node: Node<'_>, output: &mut Vec<ParseDiagnostic>) {\n    if node.is_error() || node.is_missing() {\n        output.push(ParseDiagnostic {\n            kind: if node.is_missing() {\n                format!("missing:{}", node.kind())\n            } else {\n                node.kind().into()\n            },\n            start_byte: node.start_byte(),\n            end_byte: node.end_byte(),\n            start_row: node.start_position().row,\n            start_column: node.start_position().column,\n            end_row: node.end_position().row,\n            end_column: node.end_position().column,\n        });\n    }\n    let mut cursor = node.walk();\n    for child in node.children(&mut cursor) {\n        if child.has_error() || child.is_error() || child.is_missing() {\n            collect_error_nodes(child, output);\n        }\n    }\n}\n''',
        '''fn collect_error_nodes(node: Node<'_>, output: &mut Vec<ParseDiagnostic>) {\n    if node.is_error() || node.is_missing() {\n        output.push(ParseDiagnostic {\n            kind: if node.is_missing() {\n                format!("missing:{}", node.kind())\n            } else {\n                node.kind().into()\n            },\n            start_byte: node.start_byte(),\n            end_byte: node.end_byte(),\n            start_row: node.start_position().row,\n            start_column: node.start_position().column,\n            end_row: node.end_position().row,\n            end_column: node.end_position().column,\n        });\n    }\n    let mut cursor = node.walk();\n    for child in node.children(&mut cursor) {\n        if child.has_error() || child.is_error() || child.is_missing() {\n            collect_error_nodes(child, output);\n        }\n    }\n}\n\nfn introduced_diagnostic_count(\n    base: &[ParseDiagnostic],\n    base_source: &[u8],\n    staged: &[ParseDiagnostic],\n    staged_source: &[u8],\n) -> usize {\n    let mut available = HashMap::<String, usize>::new();\n    for diagnostic in base {\n        *available.entry(diagnostic_signature(diagnostic, base_source)).or_default() += 1;\n    }\n    let mut introduced = 0usize;\n    for diagnostic in staged {\n        let signature = diagnostic_signature(diagnostic, staged_source);\n        match available.get_mut(&signature) {\n            Some(count) if *count > 0 => *count -= 1,\n            _ => introduced += 1,\n        }\n    }\n    introduced\n}\n\nfn diagnostic_signature(diagnostic: &ParseDiagnostic, source: &[u8]) -> String {\n    let start = diagnostic.start_byte.min(source.len());\n    let end = diagnostic.end_byte.min(source.len()).max(start);\n    format!("{}:{}", diagnostic.kind, sha256(&source[start..end]))\n}\n''',
        'diagnostic matching helpers',
    ),
]

for before, after, label in replacements:
    if before not in text:
        raise SystemExit(f'{label} block not found')
    text = text.replace(before, after, 1)

needle = '''    #[test]\n    fn existing_errors_are_separate_and_new_files_can_be_parsed() {\n'''
test = '''    #[test]\n    fn diagnostic_diff_detects_replacement_errors_without_count_growth() {\n        let base = vec![ParseDiagnostic {\n            kind: "ERROR".into(),\n            start_byte: 0, end_byte: 3,\n            start_row: 0, start_column: 0, end_row: 0, end_column: 3,\n        }];\n        let moved_same = vec![ParseDiagnostic {\n            kind: "ERROR".into(),\n            start_byte: 2, end_byte: 5,\n            start_row: 0, start_column: 2, end_row: 0, end_column: 5,\n        }];\n        assert_eq!(introduced_diagnostic_count(&base, b"bad", &moved_same, b"xxbad"), 0);\n\n        let replacement = vec![ParseDiagnostic {\n            kind: "ERROR".into(),\n            start_byte: 0, end_byte: 3,\n            start_row: 0, start_column: 0, end_row: 0, end_column: 3,\n        }];\n        assert_eq!(introduced_diagnostic_count(&base, b"bad", &replacement, b"new"), 1);\n    }\n\n'''
if needle not in text:
    raise SystemExit('test insertion point not found')
text = text.replace(needle, test + needle, 1)
path.write_text(text)
