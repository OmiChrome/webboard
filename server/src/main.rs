//! Bitbench compile server.
//!
//! * `POST /api/compile` — compile a sketch, returns Intel HEX + diagnostics
//! * `GET  /api/boards`  — supported boards
//! * `GET  /api/health`  — liveness / toolchain check
//! * everything else     — the built web app (PWA) from `BITBENCH_STATIC_DIR`
//!
//! `bitbench-server build-examples <examples-dir> <out-dir>` precompiles the
//! bundled examples so the web app can work offline / without a server.

mod sketch;
mod toolchain;

use anyhow::Result;
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;
use tower_http::{
    cors::CorsLayer,
    limit::RequestBodyLimitLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use toolchain::{BOARDS, CompileOutput, Toolchain};

const MAX_SOURCE: usize = 256 * 1024;
const CACHE_ENTRIES: usize = 512;

pub struct AppState {
    toolchain: Toolchain,
    jobs: Semaphore,
    cache: Mutex<HashMap<String, CompileOutput>>,
}

#[derive(Deserialize)]
struct CompileRequest {
    board: String,
    source: String,
}

async fn health() -> impl IntoResponse {
    let ok = tokio::process::Command::new("avr-gcc").arg("--version").output().await.is_ok_and(|o| o.status.success());
    Json(serde_json::json!({ "ok": ok, "toolchain": if ok { "avr-gcc" } else { "missing" }, "version": env!("CARGO_PKG_VERSION") }))
}

async fn boards() -> impl IntoResponse {
    Json(BOARDS)
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({ "ok": false, "error": msg.into() }))).into_response()
}

async fn compile(State(st): State<Arc<AppState>>, Json(req): Json<CompileRequest>) -> Response {
    let Some(board) = toolchain::board(&req.board) else {
        return err(StatusCode::BAD_REQUEST, format!("unknown board '{}'", req.board));
    };
    if req.source.len() > MAX_SOURCE {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "sketch too large");
    }
    let key = hex::encode(Sha256::digest(format!("{}\0{}", board.id, req.source)));
    if let Some(hit) = st.cache.lock().unwrap().get(&key).cloned() {
        let mut v = serde_json::to_value(hit).unwrap();
        v["cached"] = true.into();
        return Json(v).into_response();
    }
    let _permit = st.jobs.acquire().await.unwrap();
    match st.toolchain.compile(board, &req.source).await {
        Ok(out) => {
            let mut cache = st.cache.lock().unwrap();
            if cache.len() >= CACHE_ENTRIES {
                cache.clear();
            }
            cache.insert(key, out.clone());
            let mut v = serde_json::to_value(out).unwrap();
            v["cached"] = false.into();
            Json(v).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")),
    }
}

pub fn app(state: Arc<AppState>, static_dir: Option<PathBuf>) -> Router {
    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/boards", get(boards))
        .route("/api/compile", post(compile))
        .layer(RequestBodyLimitLayer::new(MAX_SOURCE + 4096))
        .with_state(state);
    let mut router = api;
    if let Some(dir) = static_dir {
        let index = dir.join("index.html");
        router = router.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)));
    }
    router.layer(CorsLayer::permissive()).layer(TraceLayer::new_for_http())
}

fn default_core_dir() -> PathBuf {
    std::env::var("BITBENCH_CORE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../core"))
}

pub fn new_state(core_dir: PathBuf) -> Result<Arc<AppState>> {
    // A private build root per server instance avoids races between instances.
    let build_root = tempfile::Builder::new().prefix("bitbench-build-").tempdir()?.keep();
    let jobs = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    Ok(Arc::new(AppState {
        toolchain: Toolchain::new(core_dir, build_root),
        jobs: Semaphore::new(jobs),
        cache: Mutex::new(HashMap::new()),
    }))
}

async fn build_examples(examples: PathBuf, out: PathBuf) -> Result<()> {
    let state = new_state(default_core_dir())?;
    let board = toolchain::board("uno").unwrap();
    tokio::fs::create_dir_all(&out).await?;
    let index: serde_json::Value = serde_json::from_str(&tokio::fs::read_to_string(examples.join("index.json")).await?)?;
    let mut bundle = Vec::new();
    for ex in index.as_array().unwrap() {
        let id = ex["id"].as_str().unwrap();
        let src = tokio::fs::read_to_string(examples.join(id).join(format!("{id}.ino"))).await?;
        let res = state.toolchain.compile(board, &src).await?;
        if !res.ok {
            anyhow::bail!("example {id} failed to compile:\n{}", res.log);
        }
        println!("{id:<16} {:>6} bytes flash, {:>4} bytes ram", res.flash_used.unwrap(), res.ram_used.unwrap());
        let mut e = ex.clone();
        e["source"] = src.into();
        e["hex"] = res.hex.unwrap().into();
        e["board"] = "uno".into();
        e["flash_used"] = res.flash_used.into();
        e["ram_used"] = res.ram_used.into();
        bundle.push(e);
    }
    tokio::fs::write(out.join("examples.json"), serde_json::to_string_pretty(&bundle)?).await?;
    println!("wrote {}", out.join("examples.json").display());
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter(
        std::env::var("RUST_LOG").unwrap_or_else(|_| "info,tower_http=info".into()),
    ).init();
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("build-examples") {
        let ex = args.get(2).map(PathBuf::from).unwrap_or_else(|| "examples".into());
        let out = args.get(3).map(PathBuf::from).unwrap_or_else(|| "web/public".into());
        return build_examples(ex, out).await;
    }
    let state = new_state(default_core_dir())?;
    let static_dir = std::env::var("BITBENCH_STATIC_DIR").ok().map(PathBuf::from);
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8787);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("bitbench-server listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app(state, static_dir)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn post_compile(source: &str) -> serde_json::Value {
        let state = new_state(default_core_dir()).unwrap();
        let body = serde_json::json!({ "board": "uno", "source": source }).to_string();
        let res = app(state, None)
            .oneshot(Request::post("/api/compile").header("content-type", "application/json").body(Body::from(body)).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn compiles_blink() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../examples/Blink/Blink.ino")).unwrap();
        let v = post_compile(&src).await;
        assert_eq!(v["ok"], true, "{}", v["log"]);
        assert!(v["hex"].as_str().unwrap().starts_with(':'));
        assert!(v["hex"].as_str().unwrap().trim_end().ends_with(":00000001FF"));
        assert!(v["flash_used"].as_u64().unwrap() < 2000);
    }

    #[tokio::test]
    async fn reports_errors_with_sketch_line_numbers() {
        let v = post_compile("void setup() {}\n\nvoid loop() {\n  undefinedThing();\n}\n").await;
        assert_eq!(v["ok"], false);
        let d = &v["diagnostics"][0];
        assert_eq!(d["line"], 4, "{}", v["log"]);
        assert_eq!(d["severity"], "error");
    }

    #[tokio::test]
    async fn forward_references_work() {
        let v = post_compile("void setup() { helper(3); }\nvoid loop() {}\nint helper(int n) { return n * 2; }\n").await;
        assert_eq!(v["ok"], true, "{}", v["log"]);
    }

    #[tokio::test]
    async fn missing_setup_gets_a_friendly_hint_and_no_paths() {
        let v = post_compile("int x;\n").await;
        assert_eq!(v["ok"], false);
        let log = v["log"].as_str().unwrap();
        assert!(log.contains("Every sketch needs a `void setup()` function."), "{log}");
        assert!(!log.contains("/tmp/") && !log.contains("/home/"), "{log}");
    }

    #[tokio::test]
    async fn rejects_unknown_board() {
        let state = new_state(default_core_dir()).unwrap();
        let body = serde_json::json!({ "board": "toaster", "source": "" }).to_string();
        let res = app(state, None)
            .oneshot(Request::post("/api/compile").header("content-type", "application/json").body(Body::from(body)).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }
}
