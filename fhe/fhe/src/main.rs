mod handlers;
mod fhe_engine;
mod config;

use axum::{routing::{post, get}, Router, extract::DefaultBodyLimit, Json};
use handlers::evaluation_handler;
use std::net::SocketAddr;
use serde_json::json;

#[tokio::main]
async fn main() {
    // Load env from shared location (trade-executor/.env) or local fallback
    let env_paths = ["../trade-executor/.env", ".env", "../../trade-executor/.env"];
    for path in &env_paths {
        if std::path::Path::new(path).exists() {
            dotenv::from_path(path).ok();
            println!("Loaded env from {}", path);
            break;
        }
    }
    
    println!("--- Starting Syphon FHE Co-Processor (Rust - REAL COMPUTE MODE) ---");
    
    // This engine is server-to-server only: the trade-executor reaches it over the internal
    // compose network (fhe-engine:5001). It is NOT published to the host (see docker-compose.prod.yml)
    // and browsers never call it, so no CORS layer is needed. Cap the body so an attacker who does
    // reach the port can't force multi-GB allocations before the expensive homomorphic work begins.
    // 128 MiB comfortably exceeds the ~23 MiB compressed ServerKey carried in evaluate payloads.
    let app = Router::new()
        .route("/evaluateStrategy", post(evaluation_handler::evaluate_strategy))
        .route("/evaluateCondition", post(evaluation_handler::evaluate_condition))
        .route("/evaluateTree", post(evaluation_handler::evaluate_tree))
        .route("/evaluateBatch", post(evaluation_handler::evaluate_batch))
        .route("/health", get(health_check))
        .layer(DefaultBodyLimit::max(128 * 1024 * 1024))
        // Transparent gzip request bodies: the executor gzips the cold-path full-key retry
        // (~24MB hex → ~7MB). Wire size is still capped by the body limit above.
        .layer(tower_http::decompression::RequestDecompressionLayer::new())
        .with_state(evaluation_handler::KeyCache::default());

    let addr = SocketAddr::from(([0, 0, 0, 0], 5001));
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    println!("--- Listening for FHE tasks on http://localhost:5001/evaluateStrategy ---\n");
    axum::serve(listener, app).await.unwrap();
}

async fn health_check() -> Json<serde_json::Value> {
    Json(json!({"status": "healthy", "service": "fhe-engine"}))
}