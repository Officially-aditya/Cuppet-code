use crate::memory::{normalize_key, MemoryRecord};
use crate::trie::TernaryTrie;
use crate::SNAPSHOT_SCHEMA_VERSION;
use anyhow::{anyhow, Context, Result};
use crc32fast::Hasher;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const SNAPSHOT_MAGIC: &[u8; 8] = b"CUPTST01";
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Snapshot {
    schema: u32,
    records: HashMap<String, MemoryRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
enum WalEvent {
    Upsert(MemoryRecord),
    Tombstone { id: String, timestamp_ms: u64 },
    StalePath { path: String, current_hash: String },
}

#[derive(Debug)]
pub struct RecoveryReport {
    pub used_previous_snapshot: bool,
    pub truncated_wal_bytes: u64,
    pub warnings: Vec<String>,
}

impl RecoveryReport {
    fn clean() -> Self {
        Self {
            used_previous_snapshot: false,
            truncated_wal_bytes: 0,
            warnings: Vec::new(),
        }
    }
}

pub struct DurableStore {
    directory: PathBuf,
    snapshot_path: PathBuf,
    previous_path: PathBuf,
    snapshot_generation_path: PathBuf,
    wal_path: PathBuf,
    _lock: File,
    append_lock: File,
    wal: File,
    records: HashMap<String, MemoryRecord>,
    trie: TernaryTrie,
    recovery: RecoveryReport,
    exclusive: bool,
    snapshot_generation: u64,
    wal_position: u64,
}

impl DurableStore {
    pub fn open(directory: impl AsRef<Path>) -> Result<Self> {
        let directory = directory.as_ref().to_path_buf();
        fs::create_dir_all(&directory)
            .with_context(|| format!("create store directory {}", directory.display()))?;
        set_private_dir_mode(&directory)?;

        let lock_path = directory.join("writer.lock");
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .with_context(|| format!("open writer lock {}", lock_path.display()))?;
        set_private_file_mode(&lock)?;

        let exclusive = lock.try_lock_exclusive().is_ok();

        let snapshot_path = directory.join("snapshot.msgpack");
        let previous_path = directory.join("snapshot.previous.msgpack");
        let snapshot_generation_path = directory.join("snapshot.generation");
        let wal_path = directory.join("events.wal");
        let recovery = RecoveryReport::clean();

        let append_lock_path = directory.join("append.lock");
        let append_lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&append_lock_path)
            .with_context(|| format!("open append lock {}", append_lock_path.display()))?;
        set_private_file_mode(&append_lock)?;

        let wal = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&wal_path)
            .with_context(|| format!("open WAL {}", wal_path.display()))?;
        set_private_file_mode(&wal)?;
        let mut store = Self {
            directory,
            snapshot_path,
            previous_path,
            snapshot_generation_path,
            wal_path,
            _lock: lock,
            append_lock,
            wal,
            records: HashMap::new(),
            trie: TernaryTrie::default(),
            recovery,
            exclusive,
            snapshot_generation: 0,
            wal_position: 0,
        };
        store.with_append_lock(|store| {
            store.reload_snapshot()?;
            store.replay_wal()?;
            Ok(())
        })?;
        store.rebuild_trie();
        Ok(store)
    }

    fn with_append_lock<T>(&mut self, operation: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        self.append_lock
            .lock_exclusive()
            .context("lock WAL append lock")?;
        let result = operation(self);
        let unlock = FileExt::unlock(&self.append_lock).context("unlock WAL append lock");
        match (result, unlock) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
    }

    fn reload_snapshot(&mut self) -> Result<()> {
        let snapshot_path = self.snapshot_path.clone();
        let previous_path = self.previous_path.clone();
        let generation_path = self.snapshot_generation_path.clone();
        self.records = load_snapshot_records(&snapshot_path, &previous_path, &mut self.recovery)?;
        self.snapshot_generation = read_snapshot_generation(&generation_path)?;
        self.wal_position = 0;
        Ok(())
    }

    fn sync_wal_locked(&mut self) -> Result<bool> {
        let generation = read_snapshot_generation(&self.snapshot_generation_path)?;
        let mut changed = false;
        if generation != self.snapshot_generation {
            self.reload_snapshot()?;
            changed = true;
        }
        changed |= self.replay_wal()?;
        Ok(changed)
    }

    fn sync_wal_if_needed(&mut self) -> Result<()> {
        self.with_append_lock(|store| {
            if store.sync_wal_locked()? {
                store.rebuild_trie();
            }
            Ok(())
        })
    }

    fn replay_wal(&mut self) -> Result<bool> {
        let mut changed = false;
        let mut total = self.wal.metadata()?.len();
        if total < self.wal_position {
            self.reload_snapshot()?;
            total = self.wal.metadata()?.len();
            changed = true;
        }
        self.wal.seek(SeekFrom::Start(self.wal_position))?;
        if total <= self.wal_position {
            return Ok(changed);
        }
        let mut valid_end = self.wal_position;
        loop {
            let mut header = [0u8; 8];
            match self.wal.read_exact(&mut header) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(error) => return Err(error.into()),
            }
            let length = u32::from_be_bytes(header[0..4].try_into().expect("four bytes")) as usize;
            let expected_crc = u32::from_be_bytes(header[4..8].try_into().expect("four bytes"));
            if length == 0 || length > MAX_FRAME_BYTES {
                self.recovery
                    .warnings
                    .push(format!("invalid WAL frame length {length}; truncated tail"));
                break;
            }
            let mut payload = vec![0u8; length];
            if self.wal.read_exact(&mut payload).is_err() {
                self.recovery
                    .warnings
                    .push("incomplete WAL tail was truncated".into());
                break;
            }
            if crc32(&payload) != expected_crc {
                self.recovery
                    .warnings
                    .push("CRC mismatch in WAL tail; truncated corrupt frames".into());
                break;
            }
            let event: WalEvent = rmp_serde::from_slice(&payload).context("decode WAL event")?;
            self.apply(event);
            changed = true;
            valid_end += 8 + length as u64;
        }

        if valid_end < total {
            self.recovery.truncated_wal_bytes = total - valid_end;
            self.wal.set_len(valid_end)?;
            self.wal.sync_data()?;
            changed = true;
        }
        self.wal_position = valid_end;
        Ok(changed)
    }

    fn append(&mut self, event: &WalEvent) -> Result<()> {
        let payload = rmp_serde::to_vec_named(event).context("encode WAL event")?;
        if payload.len() > MAX_FRAME_BYTES {
            return Err(anyhow!("WAL event exceeds frame limit"));
        }
        let mut frame = Vec::with_capacity(8 + payload.len());
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(&crc32(&payload).to_be_bytes());
        frame.extend_from_slice(&payload);
        self.with_append_lock(|store| {
            if store.sync_wal_locked()? {
                store.rebuild_trie();
            }
            store.wal.seek(SeekFrom::End(0))?;
            store.wal.write_all(&frame)?;
            store.wal.sync_data()?;
            store.wal_position = store.wal.metadata()?.len();
            Ok(())
        })
    }

    fn apply(&mut self, event: WalEvent) {
        match event {
            WalEvent::Upsert(record) => {
                self.records.insert(record.id.clone(), record);
            }
            WalEvent::Tombstone { id, timestamp_ms } => {
                if let Some(record) = self.records.get_mut(&id) {
                    record.tombstone = true;
                    record.updated_ms = timestamp_ms;
                }
            }
            WalEvent::StalePath { path, current_hash } => {
                for record in self.records.values_mut() {
                    if record
                        .file_hashes
                        .get(&path)
                        .is_some_and(|stored| stored != &current_hash)
                    {
                        record.stale = true;
                    }
                }
            }
        }
    }

    pub fn upsert(&mut self, mut record: MemoryRecord) -> Result<()> {
        record.normalized_key = normalize_key(&record.key);
        let event = WalEvent::Upsert(record.clone());
        self.append(&event)?;
        self.apply(event);
        if !record.tombstone {
            self.trie.insert(&record.normalized_key, record.id.clone());
        }
        Ok(())
    }

    pub fn tombstone(&mut self, id: &str, timestamp_ms: u64) -> Result<bool> {
        self.sync_wal_if_needed()?;
        if !self.records.contains_key(id) {
            return Ok(false);
        }
        let event = WalEvent::Tombstone {
            id: id.into(),
            timestamp_ms,
        };
        self.append(&event)?;
        self.apply(event);
        self.rebuild_trie();
        Ok(true)
    }

    pub fn invalidate_path(&mut self, path: &str, current_hash: &str) -> Result<usize> {
        self.sync_wal_if_needed()?;
        let before = self.records.values().filter(|record| record.stale).count();
        let event = WalEvent::StalePath {
            path: path.into(),
            current_hash: current_hash.into(),
        };
        self.append(&event)?;
        self.apply(event);
        let after = self.records.values().filter(|record| record.stale).count();
        Ok(after.saturating_sub(before))
    }

    pub fn exact(&mut self, key: &str) -> Option<MemoryRecord> {
        let _ = self.sync_wal_if_needed();
        let id = self.trie.get(key)?.to_owned();
        let record = self.records.get_mut(&id)?;
        if record.tombstone || record.stale || !record.verified {
            return None;
        }
        record.access_count += 1;
        Some(record.clone())
    }

    pub fn query(&mut self, query: &str, limit: usize) -> Vec<MemoryRecord> {
        let _ = self.sync_wal_if_needed();
        let normalized = normalize_key(query);
        let mut ids = self.trie.prefix(&normalized, limit);
        if ids.len() < limit {
            let terms: Vec<&str> = normalized.split_whitespace().collect();
            let mut fallback: Vec<_> = self
                .records
                .values()
                .filter(|record| record.verified && !record.stale && !record.tombstone)
                .filter_map(|record| {
                    let haystack = format!("{} {}", record.normalized_key, record.value.to_lowercase());
                    let score = terms.iter().filter(|term| haystack.contains(**term)).count();
                    (score > 0).then_some((score, record.updated_ms, record.id.clone()))
                })
                .collect();
            fallback.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
            for (_, _, id) in fallback {
                if ids.len() >= limit {
                    break;
                }
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        let mut output = Vec::new();
        for id in ids {
            if output.len() >= limit {
                break;
            }
            let Some(record) = self.records.get_mut(&id) else {
                continue;
            };
            if !record.verified || record.stale || record.tombstone {
                continue;
            }
            record.access_count += 1;
            output.push(record.clone());
        }
        output
    }

    pub fn compact(&mut self) -> Result<()> {
        if !self.exclusive {
            if self._lock.try_lock_exclusive().is_ok() {
                self.exclusive = true;
            } else {
                return self.flush();
            }
        }
        self.with_append_lock(|store| {
            if store.sync_wal_locked()? {
                store.rebuild_trie();
            }
            store.records.retain(|_, record| !record.tombstone);
            let snapshot = Snapshot {
                schema: SNAPSHOT_SCHEMA_VERSION,
                records: store.records.clone(),
            };
            let payload = rmp_serde::to_vec_named(&snapshot).context("encode snapshot")?;
            let temporary = store.directory.join("snapshot.next.msgpack");
            write_snapshot(&temporary, &payload)?;

            if store.snapshot_path.exists() {
                if store.previous_path.exists() {
                    fs::remove_file(&store.previous_path)?;
                }
                fs::rename(&store.snapshot_path, &store.previous_path)?;
            }
            fs::rename(&temporary, &store.snapshot_path)?;
            sync_directory(&store.directory)?;

            let next_generation = store.snapshot_generation.checked_add(1).unwrap_or(1);
            write_snapshot_generation(&store.snapshot_generation_path, next_generation)?;
            store.snapshot_generation = next_generation;
            store.wal.set_len(0)?;
            store.wal.seek(SeekFrom::Start(0))?;
            store.wal.sync_all()?;
            store.wal_position = 0;
            store.rebuild_trie();
            Ok(())
        })
    }

    pub fn flush(&mut self) -> Result<()> {
        self.with_append_lock(|store| store.wal.sync_all().context("fsync WAL"))
    }

    pub fn recovery(&self) -> &RecoveryReport {
        &self.recovery
    }

    pub fn stats(&self) -> StoreStats {
        StoreStats {
            records: self.records.values().filter(|record| !record.tombstone).count(),
            stale: self
                .records
                .values()
                .filter(|record| record.stale && !record.tombstone)
                .count(),
            trie_nodes: self.trie.node_count(),
            wal_bytes: fs::metadata(&self.wal_path).map(|item| item.len()).unwrap_or(0),
        }
    }

    pub fn records(&self) -> impl Iterator<Item = &MemoryRecord> {
        self.records.values()
    }

    fn rebuild_trie(&mut self) {
        self.trie = TernaryTrie::default();
        for record in self.records.values() {
            if record.verified && !record.stale && !record.tombstone {
                self.trie.insert(&record.normalized_key, record.id.clone());
            }
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct StoreStats {
    pub records: usize,
    pub stale: usize,
    pub trie_nodes: usize,
    pub wal_bytes: u64,
}

fn load_snapshot_records(
    snapshot_path: &Path,
    previous_path: &Path,
    recovery: &mut RecoveryReport,
) -> Result<HashMap<String, MemoryRecord>> {
    match read_snapshot(snapshot_path) {
        Ok(Some(snapshot)) => Ok(migrate(snapshot)?.records),
        Ok(None) => Ok(HashMap::new()),
        Err(primary_error) => match read_snapshot(previous_path) {
            Ok(Some(snapshot)) => {
                recovery.used_previous_snapshot = true;
                recovery.warnings.push(format!(
                    "primary snapshot invalid ({primary_error}); recovered previous snapshot"
                ));
                Ok(migrate(snapshot)?.records)
            }
            Ok(None) => {
                recovery.warnings.push(format!(
                    "primary snapshot invalid ({primary_error}); starting empty"
                ));
                Ok(HashMap::new())
            }
            Err(previous_error) => Err(anyhow!(
                "both snapshots are invalid: primary={primary_error}; previous={previous_error}"
            )),
        },
    }
}

fn read_snapshot_generation(path: &Path) -> Result<u64> {
    match fs::read_to_string(path) {
        Ok(value) => value
            .trim()
            .parse()
            .with_context(|| format!("parse snapshot generation {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error.into()),
    }
}

fn write_snapshot_generation(path: &Path, generation: u64) -> Result<()> {
    let temporary = path.with_extension("next");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)?;
    set_private_file_mode(&file)?;
    file.write_all(format!("{generation}\n").as_bytes())?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    if let Some(directory) = path.parent() {
        sync_directory(directory)?;
    }
    Ok(())
}

fn read_snapshot(path: &Path) -> Result<Option<Snapshot>> {
    if !path.exists() {
        return Ok(None);
    }
    let mut file = File::open(path)?;
    set_private_file_mode(&file)?;
    let mut header = [0u8; 16];
    file.read_exact(&mut header)?;
    if &header[0..8] != SNAPSHOT_MAGIC {
        return Err(anyhow!("invalid snapshot magic"));
    }
    let expected_crc = u32::from_be_bytes(header[8..12].try_into().expect("four bytes"));
    let length = u32::from_be_bytes(header[12..16].try_into().expect("four bytes")) as usize;
    if length > MAX_FRAME_BYTES * 16 {
        return Err(anyhow!("snapshot exceeds size limit"));
    }
    let mut payload = vec![0u8; length];
    file.read_exact(&mut payload)?;
    if crc32(&payload) != expected_crc {
        return Err(anyhow!("snapshot CRC mismatch"));
    }
    Ok(Some(rmp_serde::from_slice(&payload)?))
}

fn write_snapshot(path: &Path, payload: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)?;
    set_private_file_mode(&file)?;
    file.write_all(SNAPSHOT_MAGIC)?;
    file.write_all(&crc32(payload).to_be_bytes())?;
    file.write_all(&(payload.len() as u32).to_be_bytes())?;
    file.write_all(payload)?;
    file.sync_all()?;
    Ok(())
}

fn migrate(snapshot: Snapshot) -> Result<Snapshot> {
    match snapshot.schema {
        SNAPSHOT_SCHEMA_VERSION => Ok(snapshot),
        version if version < SNAPSHOT_SCHEMA_VERSION => Ok(Snapshot {
            schema: SNAPSHOT_SCHEMA_VERSION,
            records: snapshot.records,
        }),
        version => Err(anyhow!(
            "snapshot schema {version} is newer than supported schema {SNAPSHOT_SCHEMA_VERSION}"
        )),
    }
}

fn crc32(payload: &[u8]) -> u32 {
    let mut hasher = Hasher::new();
    hasher.update(payload);
    hasher.finalize()
}

#[cfg(unix)]
fn set_private_dir_mode(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    Ok(())
}

#[cfg(unix)]
fn set_private_file_mode(file: &File) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_file_mode(_file: &File) -> Result<()> {
    Ok(())
}

#[cfg(not(unix))]
fn set_private_dir_mode(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{MemoryKind, MemoryScope, Provenance};
    use std::collections::BTreeMap;
    use std::io::Write;

    fn record(id: &str, key: &str) -> MemoryRecord {
        MemoryRecord {
            id: id.into(),
            key: key.into(),
            normalized_key: normalize_key(key),
            value: "value".into(),
            kind: MemoryKind::Preference,
            scope: MemoryScope::Project,
            provenance: Provenance::ExplicitUser,
            score: 1.0,
            pinned: false,
            verified: true,
            stale: false,
            tombstone: false,
            created_ms: 1,
            updated_ms: 1,
            access_count: 0,
            evidence: Vec::new(),
            file_hashes: BTreeMap::new(),
        }
    }

    #[test]
    fn truncates_partial_wal_tail_and_recovers_records() {
        let temp = tempfile::tempdir().unwrap();
        {
            let mut store = DurableStore::open(temp.path()).unwrap();
            store.upsert(record("1", "alpha")).unwrap();
        }
        let wal_path = temp.path().join("events.wal");
        OpenOptions::new()
            .append(true)
            .open(&wal_path)
            .unwrap()
            .write_all(&[0, 0, 0, 100, 1, 2])
            .unwrap();
        let mut store = DurableStore::open(temp.path()).unwrap();
        assert!(store.recovery().truncated_wal_bytes > 0);
        assert_eq!(store.exact("alpha").unwrap().id, "1");
    }

    #[test]
    fn compact_snapshot_survives_restart() {
        let temp = tempfile::tempdir().unwrap();
        {
            let mut store = DurableStore::open(temp.path()).unwrap();
            store.upsert(record("1", "alpha beta")).unwrap();
            store.compact().unwrap();
        }
        let mut reopened = DurableStore::open(temp.path()).unwrap();
        assert_eq!(reopened.exact("alpha beta").unwrap().id, "1");
        assert_eq!(reopened.stats().wal_bytes, 0);
    }

    #[test]
    fn concurrent_writers_survive_compaction_without_losing_records() {
        let temp = tempfile::tempdir().unwrap();
        let mut first = DurableStore::open(temp.path()).unwrap();
        let mut second = DurableStore::open(temp.path()).unwrap();

        first.upsert(record("1", "alpha")).unwrap();
        second.upsert(record("2", "beta")).unwrap();
        first.compact().unwrap();
        second.upsert(record("3", "gamma")).unwrap();
        drop(first);
        drop(second);

        let mut reopened = DurableStore::open(temp.path()).unwrap();
        assert_eq!(reopened.exact("alpha").unwrap().id, "1");
        assert_eq!(reopened.exact("beta").unwrap().id, "2");
        assert_eq!(reopened.exact("gamma").unwrap().id, "3");
    }

    #[test]
    fn corrupt_primary_snapshot_falls_back_to_previous_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        {
            let mut store = DurableStore::open(temp.path()).unwrap();
            store.upsert(record("1", "alpha")).unwrap();
            store.compact().unwrap();
            store.upsert(record("2", "beta")).unwrap();
            store.compact().unwrap();
        }
        fs::write(temp.path().join("snapshot.msgpack"), b"corrupt").unwrap();
        let mut reopened = DurableStore::open(temp.path()).unwrap();
        assert!(reopened.recovery().used_previous_snapshot);
        assert_eq!(reopened.exact("alpha").unwrap().id, "1");
        assert!(reopened.exact("beta").is_none());
    }

    #[test]
    fn crc_corrupt_wal_tail_is_truncated() {
        let temp = tempfile::tempdir().unwrap();
        {
            let mut store = DurableStore::open(temp.path()).unwrap();
            store.upsert(record("1", "alpha")).unwrap();
        }
        let wal_path = temp.path().join("events.wal");
        let mut bytes = fs::read(&wal_path).unwrap();
        let last = bytes.last_mut().unwrap();
        *last ^= 0xff;
        fs::write(&wal_path, bytes).unwrap();
        let store = DurableStore::open(temp.path()).unwrap();
        assert!(store.recovery().truncated_wal_bytes > 0);
        assert!(store
            .recovery()
            .warnings
            .iter()
            .any(|warning| warning.contains("CRC mismatch")));
        assert_eq!(store.stats().wal_bytes, 0);
    }

    #[cfg(unix)]
    #[test]
    fn store_files_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let mut store = DurableStore::open(temp.path()).unwrap();
        store.upsert(record("1", "private")).unwrap();
        store.compact().unwrap();
        for name in [
            "writer.lock",
            "append.lock",
            "events.wal",
            "snapshot.msgpack",
            "snapshot.generation",
        ] {
            let mode = fs::metadata(temp.path().join(name)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{name} should be private");
        }
    }
}
