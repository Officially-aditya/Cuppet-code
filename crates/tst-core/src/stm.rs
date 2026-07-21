use crate::memory::{normalize_key, MemoryRecord};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum StmError {
    #[error("short-term memory is full and every entry is pinned")]
    AllSlotsPinned,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
struct SlotRef {
    index: usize,
    generation: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Slot {
    generation: u64,
    entry: Option<MemoryRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ShortTermMemory {
    session_id: String,
    slots: Vec<Slot>,
    #[serde(skip)]
    index: HashMap<String, SlotRef>,
    next_generation: u64,
}

impl ShortTermMemory {
    pub fn new(session_id: impl Into<String>, capacity: usize) -> Self {
        assert!(capacity > 0, "STM capacity must be non-zero");
        Self {
            session_id: session_id.into(),
            slots: (0..capacity)
                .map(|_| Slot {
                    generation: 0,
                    entry: None,
                })
                .collect(),
            index: HashMap::new(),
            next_generation: 1,
        }
    }

    pub fn rebuild_index(&mut self) {
        self.index.clear();
        for (index, slot) in self.slots.iter().enumerate() {
            if let Some(entry) = &slot.entry {
                self.index.insert(
                    entry.normalized_key.clone(),
                    SlotRef {
                        index,
                        generation: slot.generation,
                    },
                );
            }
        }
    }

    pub fn upsert(&mut self, mut entry: MemoryRecord) -> Result<String, StmError> {
        entry.normalized_key = normalize_key(&entry.key);
        if let Some(reference) = self.index.get(&entry.normalized_key).copied() {
            if let Some(slot) = self.slots.get_mut(reference.index) {
                if slot.generation == reference.generation {
                    if let Some(existing) = slot.entry.as_mut() {
                        existing.value = entry.value;
                        existing.updated_ms = entry.updated_ms;
                        existing.access_count += 1;
                        existing.score = (existing.score + 0.1).min(1.0);
                        existing.pinned |= entry.pinned;
                        existing.evidence.extend(entry.evidence);
                        existing.file_hashes.extend(entry.file_hashes);
                        return Ok(existing.id.clone());
                    }
                }
            }
            self.index.remove(&entry.normalized_key);
        }

        let target = self
            .slots
            .iter()
            .position(|slot| slot.entry.is_none())
            .or_else(|| self.eviction_candidate())
            .ok_or(StmError::AllSlotsPinned)?;

        if let Some(previous) = self.slots[target].entry.take() {
            if self.index.get(&previous.normalized_key).is_some_and(|reference| {
                reference.index == target && reference.generation == self.slots[target].generation
            }) {
                self.index.remove(&previous.normalized_key);
            }
        }

        let generation = self.next_generation;
        self.next_generation = self.next_generation.saturating_add(1);
        let id = entry.id.clone();
        self.slots[target] = Slot {
            generation,
            entry: Some(entry),
        };
        let normalized = self.slots[target]
            .entry
            .as_ref()
            .expect("newly populated slot")
            .normalized_key
            .clone();
        self.index.insert(
            normalized,
            SlotRef {
                index: target,
                generation,
            },
        );
        Ok(id)
    }

    fn eviction_candidate(&self) -> Option<usize> {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(index, slot)| slot.entry.as_ref().map(|entry| (index, entry)))
            .filter(|(_, entry)| !entry.pinned)
            .min_by(|(_, left), (_, right)| {
                left.score
                    .partial_cmp(&right.score)
                    .unwrap_or(Ordering::Equal)
                    .then_with(|| left.updated_ms.cmp(&right.updated_ms))
            })
            .map(|(index, _)| index)
    }

    pub fn decay(&mut self, beta: f32) {
        for slot in &mut self.slots {
            if let Some(entry) = slot.entry.as_mut() {
                if !entry.pinned {
                    entry.score = (entry.score * beta).clamp(0.0, 1.0);
                }
            }
        }
    }

    pub fn query(&mut self, query: &str, limit: usize) -> Vec<MemoryRecord> {
        let terms: Vec<String> = normalize_key(query)
            .split_whitespace()
            .map(ToOwned::to_owned)
            .collect();
        let mut scored = Vec::new();
        for slot in &mut self.slots {
            let Some(entry) = slot.entry.as_mut() else {
                continue;
            };
            let text = format!("{} {}", entry.normalized_key, entry.value.to_lowercase());
            let matches = terms.iter().filter(|term| text.contains(term.as_str())).count();
            if matches > 0 || entry.pinned {
                entry.access_count += 1;
                scored.push((matches as f32 * 10.0 + entry.score, entry.clone()));
            }
        }
        scored.sort_by(|left, right| {
            right
                .0
                .partial_cmp(&left.0)
                .unwrap_or(Ordering::Equal)
                .then_with(|| right.1.updated_ms.cmp(&left.1.updated_ms))
        });
        scored.into_iter().take(limit).map(|(_, entry)| entry).collect()
    }

    pub fn entries(&self) -> impl Iterator<Item = &MemoryRecord> {
        self.slots.iter().filter_map(|slot| slot.entry.as_ref())
    }

    pub fn entries_mut(&mut self) -> impl Iterator<Item = &mut MemoryRecord> {
        self.slots.iter_mut().filter_map(|slot| slot.entry.as_mut())
    }

    pub fn remove(&mut self, key: &str) -> bool {
        let normalized = normalize_key(key);
        let Some(reference) = self.index.remove(&normalized) else {
            return false;
        };
        let Some(slot) = self.slots.get_mut(reference.index) else {
            return false;
        };
        if slot.generation != reference.generation {
            return false;
        }
        slot.entry.take().is_some()
    }

    pub fn len(&self) -> usize {
        self.slots.iter().filter(|slot| slot.entry.is_some()).count()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn capacity(&self) -> usize {
        self.slots.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{MemoryKind, MemoryScope, Provenance};
    use std::collections::BTreeMap;

    fn record(key: &str, score: f32, pinned: bool, updated_ms: u64) -> MemoryRecord {
        MemoryRecord {
            id: format!("id:{key}"),
            key: key.into(),
            normalized_key: String::new(),
            value: key.into(),
            kind: MemoryKind::ConceptAnchor,
            scope: MemoryScope::Session,
            provenance: Provenance::ModelCandidate,
            score,
            pinned,
            verified: false,
            stale: false,
            tombstone: false,
            created_ms: updated_ms,
            updated_ms,
            access_count: 0,
            evidence: Vec::new(),
            file_hashes: BTreeMap::new(),
        }
    }

    #[test]
    fn evicts_lowest_score_then_oldest_and_keeps_index_generation_safe() {
        let mut stm = ShortTermMemory::new("s", 2);
        stm.upsert(record("same", 0.2, false, 1)).unwrap();
        stm.upsert(record("other", 0.9, false, 2)).unwrap();
        stm.upsert(record("replacement", 0.8, false, 3)).unwrap();
        assert!(stm.query("same", 10).is_empty());
        assert_eq!(stm.query("replacement", 10).len(), 1);
        stm.upsert(record("same", 0.7, false, 4)).unwrap();
        assert_eq!(stm.query("same", 10).len(), 1);
    }

    #[test]
    fn rejects_when_every_slot_is_pinned() {
        let mut stm = ShortTermMemory::new("s", 1);
        stm.upsert(record("pinned", 1.0, true, 1)).unwrap();
        assert_eq!(
            stm.upsert(record("new", 1.0, false, 2)),
            Err(StmError::AllSlotsPinned)
        );
    }

    #[test]
    fn reinforcement_and_decay_follow_policy() {
        let mut stm = ShortTermMemory::new("s", 2);
        stm.upsert(record("key", 0.5, false, 1)).unwrap();
        stm.upsert(record("key", 0.5, false, 2)).unwrap();
        let before = stm.query("key", 1).remove(0).score;
        assert!((before - 0.6).abs() < f32::EPSILON);
        stm.decay(0.98);
        let after = stm.query("key", 1).remove(0).score;
        assert!((after - 0.588).abs() < 0.0001);
    }
}
