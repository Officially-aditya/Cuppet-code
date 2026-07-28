use anyhow::{anyhow, Context, Result};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::ErrorKind;
#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc, Mutex, Notify};
use tst_core::memory::MemoryScope;
use tst_core::service::{
    ContextPrepareInput, EvidenceInput, ObserveInput, QueryInput, RememberInput, TstService,
};
use tst_core::PROTOCOL_VERSION;

const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
struct Options {
    socket: PathBuf,
    project_root: PathBuf,
    project_store: PathBuf,
    global_store: PathBuf,
    token: String,
}

#[derive(Debug, Deserialize)]
struct Request {
    jsonrpc: String,
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct Response {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
struct RpcError {
    code: i32,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
struct RpcNotification {
    jsonrpc: &'static str,
    method: String,
    params: Value,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("tst-daemon: {error:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    if env::args().nth(1).as_deref() == Some("--protocol") {
        println!("{PROTOCOL_VERSION}");
        return Ok(());
    }
    let options = Options::parse()?;
    prepare_socket(&options.socket)?;
    let listener = UnixListener::bind(&options.socket)
        .with_context(|| format!("bind socket {}", options.socket.display()))?;
    set_socket_mode(&options.socket)?;

    let service = Arc::new(Mutex::new(TstService::open(
        &options.project_root,
        &options.project_store,
        &options.global_store,
    )?));
    let shutdown = Arc::new(Notify::new());
    let (events, _) = broadcast::channel::<RpcNotification>(256);

    spawn_initial_index(service.clone(), events.clone());
    spawn_watcher(options.project_root.clone(), service.clone(), events.clone())?;

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let service = service.clone();
                let shutdown = shutdown.clone();
                let token = options.token.clone();
                let events = events.clone();
                tokio::spawn(async move {
                    if let Err(error) = serve_connection(stream, service, shutdown, token, events).await {
                        if !is_expected_disconnect(&error) {
                            eprintln!("tst-daemon connection: {error:#}");
                        }
                    }
                });
            }
            _ = shutdown.notified() => break,
        }
    }

    service.lock().await.flush()?;
    drop(listener);
    let _ = fs::remove_file(&options.socket);
    Ok(())
}

fn is_expected_disconnect(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.downcast_ref::<std::io::Error>().is_some_and(|io_error| {
            matches!(
                io_error.kind(),
                ErrorKind::BrokenPipe | ErrorKind::ConnectionReset | ErrorKind::UnexpectedEof
            )
        })
    })
}

impl Options {
    fn parse() -> Result<Self> {
        let mut socket = None;
        let mut project_root = None;
        let mut project_store = None;
        let mut global_store = None;
        let mut arguments = env::args().skip(1);
        while let Some(argument) = arguments.next() {
            let value = arguments
                .next()
                .ok_or_else(|| anyhow!("missing value for {argument}"))?;
            match argument.as_str() {
                "--socket" => socket = Some(PathBuf::from(value)),
                "--project-root" => project_root = Some(PathBuf::from(value)),
                "--project-store" => project_store = Some(PathBuf::from(value)),
                "--global-store" => global_store = Some(PathBuf::from(value)),
                _ => return Err(anyhow!("unknown argument {argument}")),
            }
        }
        let token =
            env::var("CUPPET_TST_TOKEN").context("CUPPET_TST_TOKEN must be supplied by the supervisor")?;
        if token.len() < 32 {
            return Err(anyhow!("CUPPET_TST_TOKEN is too short"));
        }
        Ok(Self {
            socket: socket.ok_or_else(|| anyhow!("--socket is required"))?,
            project_root: project_root.ok_or_else(|| anyhow!("--project-root is required"))?,
            project_store: project_store.ok_or_else(|| anyhow!("--project-store is required"))?,
            global_store: global_store.ok_or_else(|| anyhow!("--global-store is required"))?,
            token,
        })
    }
}

async fn serve_connection(
    stream: UnixStream,
    service: Arc<Mutex<TstService>>,
    shutdown: Arc<Notify>,
    expected_token: String,
    events: broadcast::Sender<RpcNotification>,
) -> Result<()> {
    let mut authenticated = false;
    let mut notifications_enabled = false;
    let mut event_receiver = events.subscribe();
    let (mut reader, mut writer) = stream.into_split();
    loop {
        let payload = tokio::select! {
            payload = read_frame(&mut reader) => {
                let Some(payload) = payload? else { break };
                payload
            }
            notification = event_receiver.recv() => {
                if let Ok(notification) = notification {
                    if authenticated && notifications_enabled {
                        write_message(&mut writer, &notification).await?;
                    }
                }
                continue;
            }
        };
        let request: Request = match serde_json::from_slice(&payload) {
            Ok(request) => request,
            Err(error) => {
                write_response(
                    &mut writer,
                    Response::error(Value::Null, -32700, format!("parse error: {error}")),
                )
                .await?;
                continue;
            }
        };
        let id = request.id.clone().unwrap_or(Value::Null);
        if request.jsonrpc != "2.0" {
            write_response(
                &mut writer,
                Response::error(id, -32600, "jsonrpc must be 2.0".into()),
            )
            .await?;
            continue;
        }

        if request.method == "initialize" {
            let token = request
                .params
                .get("token")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !constant_time_equal(token.as_bytes(), expected_token.as_bytes()) {
                write_response(
                    &mut writer,
                    Response::error(id, -32001, "authentication failed".into()),
                )
                .await?;
                break;
            }
            authenticated = true;
            notifications_enabled = request
                .params
                .get("notifications")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            write_response(
                &mut writer,
                Response::success(
                    id,
                    json!({
                        "protocol": PROTOCOL_VERSION,
                        "capabilities": [
                            "memory.observe", "memory.query", "memory.remember", "memory.forget", "context.prepare",
                            "evidence.record", "graph.query", "graph.search", "graph.locate", "graph.list", "graph.workspace", "graph.trace", "graph.trace_summary", "status", "compact", "flush", "shutdown",
                            "notifications"
                        ]
                    }),
                ),
            )
            .await?;
            if notifications_enabled {
                let health =
                    RpcNotification::new("health", serde_json::to_value(service.lock().await.status())?);
                write_message(&mut writer, &health).await?;
            }
            continue;
        }

        if !authenticated {
            write_response(
                &mut writer,
                Response::error(id, -32001, "initialize with a valid token first".into()),
            )
            .await?;
            continue;
        }

        if !is_known_method(&request.method) {
            write_response(
                &mut writer,
                Response::error(id, -32601, format!("method not found: {}", request.method)),
            )
            .await?;
            continue;
        }

        let should_shutdown = request.method == "shutdown";
        match dispatch(&request.method, request.params, &service).await {
            Ok(result) => {
                write_response(&mut writer, Response::success(id, result.clone())).await?;
                if let Some(notification) = notification_for(&request.method, result) {
                    let _ = events.send(notification);
                }
                if should_shutdown {
                    shutdown.notify_waiters();
                }
            }
            Err(error) => {
                write_response(
                    &mut writer,
                    Response::error(id, -32000, redact_error(&format!("{error:#}"))),
                )
                .await?;
            }
        }
    }
    Ok(())
}

fn is_known_method(method: &str) -> bool {
    matches!(
        method,
        "memory.observe"
            | "memory.query"
            | "memory.remember"
            | "memory.forget"
            | "context.prepare"
            | "evidence.record"
            | "graph.query"
            | "graph.search"
            | "graph.locate"
            | "graph.list"
            | "graph.workspace"
            | "graph.trace"
            | "graph.trace_summary"
            | "turn.completed"
            | "status"
            | "compact"
            | "flush"
            | "shutdown"
    )
}

async fn dispatch(method: &str, params: Value, service: &Arc<Mutex<TstService>>) -> Result<Value> {
    match method {
        "memory.observe" => {
            let input: ObserveInput = serde_json::from_value(params)?;
            Ok(json!({ "id": service.lock().await.observe(input)? }))
        }
        "memory.query" => {
            let input: QueryInput = serde_json::from_value(params)?;
            Ok(serde_json::to_value(service.lock().await.query(input))?)
        }
        "context.prepare" => {
            let input: ContextPrepareInput = serde_json::from_value(params)?;
            Ok(serde_json::to_value(service.lock().await.prepare_context(input))?)
        }
        "memory.remember" => {
            let input: RememberInput = serde_json::from_value(params)?;
            Ok(json!({ "id": service.lock().await.remember(input)? }))
        }
        "memory.forget" => {
            let session_id = required_string(&params, "session_id")?;
            if let Some(scope) = params.get("clear_scope") {
                let scope: MemoryScope = serde_json::from_value(scope.clone())?;
                Ok(json!({ "removed": service.lock().await.clear(session_id, scope)? }))
            } else {
                let key = required_string(&params, "key")?;
                Ok(json!({ "removed": service.lock().await.forget(session_id, key)? }))
            }
        }
        "evidence.record" => {
            let input: EvidenceInput = serde_json::from_value(params)?;
            Ok(json!({ "recorded": service.lock().await.record_evidence(input)? }))
        }
        "graph.query" => {
            let query = required_string(&params, "query")?;
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize;
            Ok(serde_json::to_value(
                service.lock().await.graph_query(query, limit),
            )?)
        }
        "graph.search" => {
            let pattern = required_string(&params, "pattern")?;
            let prefix = params.get("prefix").and_then(Value::as_str);
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize;
            Ok(serde_json::to_value(
                service.lock().await.graph_search(pattern, prefix, limit),
            )?)
        }
        "graph.locate" => {
            let pattern = required_string(&params, "pattern")?;
            let prefix = params.get("prefix").and_then(Value::as_str);
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(12) as usize;
            Ok(serde_json::to_value(
                service.lock().await.graph_locate(pattern, prefix, limit),
            )?)
        }
        "graph.list" => {
            let prefix = params.get("prefix").and_then(Value::as_str);
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(100) as usize;
            Ok(serde_json::to_value(
                service.lock().await.graph_list(prefix, limit),
            )?)
        }
        "graph.workspace" => {
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(100) as usize;
            Ok(serde_json::to_value(service.lock().await.graph_workspace(limit))?)
        }
        "graph.trace" => {
            let query = required_string(&params, "query")?;
            let direction = params.get("direction").and_then(Value::as_str).unwrap_or("both");
            let depth = params.get("depth").and_then(Value::as_u64).unwrap_or(2) as usize;
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(40) as usize;
            Ok(serde_json::to_value(
                service.lock().await.graph_trace(query, direction, depth, limit)?,
            )?)
        }
        "graph.trace_summary" => {
            let query = required_string(&params, "query")?;
            let direction = params.get("direction").and_then(Value::as_str).unwrap_or("both");
            let depth = params.get("depth").and_then(Value::as_u64).unwrap_or(2) as usize;
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(12) as usize;
            Ok(serde_json::to_value(
                service
                    .lock()
                    .await
                    .graph_trace_summary(query, direction, depth, limit)?,
            )?)
        }
        "turn.completed" => {
            let session_id = required_string(&params, "session_id")?;
            Ok(json!({ "promoted": service.lock().await.completed_foreground_turn(session_id)? }))
        }
        "status" => Ok(serde_json::to_value(service.lock().await.status())?),
        "compact" => {
            service.lock().await.compact()?;
            Ok(json!({ "compacted": true }))
        }
        "flush" => {
            service.lock().await.flush()?;
            Ok(json!({ "flushed": true }))
        }
        "shutdown" => {
            service.lock().await.flush()?;
            Ok(json!({ "shutting_down": true }))
        }
        _ => Err(anyhow!("method not found: {method}")),
    }
}

fn notification_for(method: &str, result: Value) -> Option<RpcNotification> {
    let event = match method {
        "memory.observe" | "memory.remember" | "memory.forget" | "evidence.record" | "turn.completed" => {
            "memory.changed"
        }
        "compact" | "flush" => "health",
        "shutdown" => "health.shutdown",
        _ => return None,
    };
    Some(RpcNotification::new(
        event,
        json!({ "operation": method, "result": result }),
    ))
}

fn spawn_initial_index(service: Arc<Mutex<TstService>>, events: broadcast::Sender<RpcNotification>) {
    tokio::spawn(async move {
        let paths = service.lock().await.begin_graph_index();
        let discovered = paths.len();
        let _ = events.send(RpcNotification::new(
            "indexing.progress",
            json!({ "discovered": discovered, "indexed": 0, "complete": false }),
        ));
        for (index, path) in paths.into_iter().enumerate() {
            service.lock().await.index_graph_path(&path);
            let indexed = index + 1;
            if indexed % 25 == 0 || indexed == discovered {
                let _ = events.send(RpcNotification::new(
                    "indexing.progress",
                    json!({ "discovered": discovered, "indexed": indexed, "complete": false }),
                ));
            }
            tokio::task::yield_now().await;
        }
        let graph = {
            let mut service = service.lock().await;
            service.finish_graph_index();
            service.status().graph
        };
        let _ = events.send(RpcNotification::new(
            "indexing.complete",
            serde_json::to_value(graph).unwrap_or_else(|_| json!({ "complete": true })),
        ));
    });
}

fn spawn_watcher(
    root: PathBuf,
    service: Arc<Mutex<TstService>>,
    events: broadcast::Sender<RpcNotification>,
) -> Result<()> {
    let (sender, mut receiver) = mpsc::channel::<notify::Result<Event>>(256);
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |event| {
        let _ = sender.blocking_send(event);
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    tokio::spawn(async move {
        let _watcher = watcher;
        while let Some(event) = receiver.recv().await {
            let Ok(event) = event else {
                continue;
            };
            if !matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) {
                continue;
            }
            let mut paths: HashSet<PathBuf> = event.paths.into_iter().collect();
            tokio::time::sleep(Duration::from_millis(125)).await;
            while let Ok(next) = receiver.try_recv() {
                if let Ok(next) = next {
                    paths.extend(next.paths);
                }
            }
            let mut changed = 0usize;
            let graph = {
                let mut service = service.lock().await;
                for path in paths {
                    if service.update_graph_path(&path).is_ok() {
                        changed += 1;
                    }
                }
                service.status().graph
            };
            if changed > 0 {
                let _ = events.send(RpcNotification::new(
                    "graph.changed",
                    json!({ "changed_paths": changed, "graph": graph }),
                ));
            }
        }
    });
    Ok(())
}

async fn read_frame<R>(stream: &mut R) -> Result<Option<Vec<u8>>>
where
    R: AsyncRead + Unpin,
{
    let mut length = [0u8; 4];
    match stream.read_exact(&mut length).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(anyhow!("invalid RPC frame length {length}"));
    }
    let mut payload = vec![0u8; length];
    stream.read_exact(&mut payload).await?;
    Ok(Some(payload))
}

async fn write_response<W>(stream: &mut W, response: Response) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    write_message(stream, &response).await
}

async fn write_message<W, T>(stream: &mut W, message: &T) -> Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let payload = serde_json::to_vec(message)?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(anyhow!("RPC response exceeds frame limit"));
    }
    stream.write_all(&(payload.len() as u32).to_be_bytes()).await?;
    stream.write_all(&payload).await?;
    stream.flush().await?;
    Ok(())
}

impl Response {
    fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    fn error(id: Value, code: i32, message: String) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(RpcError { code, message }),
        }
    }
}

impl RpcNotification {
    fn new(method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            method: method.into(),
            params,
        }
    }
}

fn prepare_socket(path: &Path) -> Result<()> {
    let parent = path.parent().ok_or_else(|| anyhow!("socket has no parent"))?;
    fs::create_dir_all(parent)?;
    set_runtime_mode(parent)?;
    if path.exists() {
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.file_type().is_socket() {
            return Err(anyhow!("refusing to replace non-socket path {}", path.display()));
        }
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(unix)]
fn set_runtime_mode(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    Ok(())
}

#[cfg(unix)]
fn set_socket_mode(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_runtime_mode(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(not(unix))]
fn set_socket_mode(_path: &Path) -> Result<()> {
    Ok(())
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("missing string parameter {key}"))
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (left, right) in left.iter().zip(right) {
        difference |= left ^ right;
    }
    difference == 0
}

fn redact_error(message: &str) -> String {
    message
        .split_whitespace()
        .map(|part| {
            if (part.starts_with("sk-") || part.starts_with("ghp_") || part.starts_with("xoxb-"))
                && part.len() > 12
            {
                "[REDACTED]"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_comparison_and_redaction() {
        assert!(constant_time_equal(b"abc", b"abc"));
        assert!(!constant_time_equal(b"abc", b"abd"));
        assert!(redact_error("bad sk-12345678901234567890").contains("[REDACTED]"));
        assert!(is_known_method("memory.query"));
        assert!(is_known_method("context.prepare"));
        assert!(!is_known_method("filesystem.delete"));
    }
}
