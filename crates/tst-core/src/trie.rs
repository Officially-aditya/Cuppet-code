use crate::memory::normalize_key;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Node {
    ch: char,
    lo: Option<usize>,
    eq: Option<usize>,
    hi: Option<usize>,
    posting: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TernaryTrie {
    nodes: Vec<Node>,
    root: Option<usize>,
}

impl TernaryTrie {
    pub fn insert(&mut self, key: &str, canonical_id: String) {
        let normalized = normalize_key(key);
        let chars: Vec<char> = normalized.chars().collect();
        if chars.is_empty() {
            return;
        }
        self.root = Some(self.insert_at(self.root, &chars, 0, canonical_id));
    }

    fn insert_at(
        &mut self,
        node_index: Option<usize>,
        chars: &[char],
        char_index: usize,
        canonical_id: String,
    ) -> usize {
        let current = chars[char_index];
        let index = node_index.unwrap_or_else(|| {
            let index = self.nodes.len();
            self.nodes.push(Node {
                ch: current,
                lo: None,
                eq: None,
                hi: None,
                posting: None,
            });
            index
        });
        let node_char = self.nodes[index].ch;
        if current < node_char {
            let next = self.insert_at(self.nodes[index].lo, chars, char_index, canonical_id);
            self.nodes[index].lo = Some(next);
        } else if current > node_char {
            let next = self.insert_at(self.nodes[index].hi, chars, char_index, canonical_id);
            self.nodes[index].hi = Some(next);
        } else if char_index + 1 == chars.len() {
            self.nodes[index].posting = Some(canonical_id);
        } else {
            let next = self.insert_at(self.nodes[index].eq, chars, char_index + 1, canonical_id);
            self.nodes[index].eq = Some(next);
        }
        index
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        let normalized = normalize_key(key);
        let chars: Vec<char> = normalized.chars().collect();
        if chars.is_empty() {
            return None;
        }
        let index = self.find(self.root, &chars, 0)?;
        self.nodes[index].posting.as_deref()
    }

    pub fn prefix(&self, prefix: &str, limit: usize) -> Vec<String> {
        let normalized = normalize_key(prefix);
        let chars: Vec<char> = normalized.chars().collect();
        if chars.is_empty() || limit == 0 {
            return Vec::new();
        }
        let Some(index) = self.find(self.root, &chars, 0) else {
            return Vec::new();
        };
        let mut output = Vec::new();
        if let Some(posting) = &self.nodes[index].posting {
            output.push(posting.clone());
        }
        self.collect(self.nodes[index].eq, limit, &mut output);
        output
    }

    fn find(&self, node: Option<usize>, chars: &[char], char_index: usize) -> Option<usize> {
        let index = node?;
        let current = chars[char_index];
        let item = &self.nodes[index];
        if current < item.ch {
            self.find(item.lo, chars, char_index)
        } else if current > item.ch {
            self.find(item.hi, chars, char_index)
        } else if char_index + 1 == chars.len() {
            Some(index)
        } else {
            self.find(item.eq, chars, char_index + 1)
        }
    }

    fn collect(&self, node: Option<usize>, limit: usize, output: &mut Vec<String>) {
        if output.len() >= limit {
            return;
        }
        let Some(index) = node else {
            return;
        };
        let item = &self.nodes[index];
        self.collect(item.lo, limit, output);
        if output.len() < limit {
            if let Some(posting) = &item.posting {
                output.push(posting.clone());
            }
        }
        self.collect(item.eq, limit, output);
        self.collect(item.hi, limit, output);
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_does_not_leave_stale_posting() {
        let mut trie = TernaryTrie::default();
        trie.insert("build command", "old".into());
        trie.insert("build command", "new".into());
        assert_eq!(trie.get("BUILD   COMMAND"), Some("new"));
        assert_eq!(trie.prefix("build", 8), vec!["new"]);
    }
}
