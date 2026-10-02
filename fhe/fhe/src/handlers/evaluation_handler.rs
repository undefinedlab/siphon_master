use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tfhe::integer::{CompressedServerKey, RadixCiphertext, ServerKey};
use crate::fhe_engine::core as fhe_core;

// ── Server-key cache ───────────────────────────────────────────────────────────
// Expanding a CompressedServerKey (~24MB hex) into a ServerKey regenerates all the
// bootstrap/keyswitch FFT keys — seconds of work, ~200MB RAM per expanded key. Callers
// send `server_key_hash` (sha256 of the key hex); on a miss the engine answers 428
// `key_not_cached` and the caller retries once with the full key inline.

#[derive(Clone, Default)]
pub struct KeyCache {
    inner: Arc<Mutex<HashMap<String, (Arc<ServerKey>, Instant)>>>,
}

fn cache_cap() -> usize {
    std::env::var("FHE_KEY_CACHE_CAP").ok().and_then(|v| v.parse().ok()).unwrap_or(8)
}

impl KeyCache {
    fn get(&self, hash: &str) -> Option<Arc<ServerKey>> {
        let mut map = self.inner.lock().unwrap();
        map.get_mut(hash).map(|entry| {
            entry.1 = Instant::now();
            entry.0.clone()
        })
    }

    fn insert(&self, hash: String, key: Arc<ServerKey>) {
        let mut map = self.inner.lock().unwrap();
        if !map.contains_key(&hash) && map.len() >= cache_cap() {
            // ponytail: O(n) LRU scan — n is single-digit (each entry ~200MB RAM)
            if let Some(oldest) = map.iter().min_by_key(|(_, e)| e.1).map(|(k, _)| k.clone()) {
                map.remove(&oldest);
            }
        }
        map.insert(hash, (key, Instant::now()));
    }
}

/// Resolve the server key for a request: cache hit by hash, else expand the inline key
/// and cache it under sha256(key_hex), else 428 so the caller re-sends the full key.
/// Expansion runs outside the cache lock; two concurrent misses on the same key expand
/// twice and the second insert wins — harmless.
pub fn resolve_server_key(
    cache: &KeyCache,
    hash: Option<&str>,
    key_hex: Option<&str>,
) -> Result<Arc<ServerKey>, (StatusCode, String)> {
    if let Some(h) = hash {
        if let Some(key) = cache.get(h) {
            return Ok(key);
        }
    }
    let Some(key_hex) = key_hex.filter(|k| !k.is_empty()) else {
        return Err((StatusCode::PRECONDITION_REQUIRED, "key_not_cached".to_string()));
    };
    let computed = hex::encode(Sha256::digest(key_hex.as_bytes()));
    if let Some(key) = cache.get(&computed) {
        return Ok(key);
    }
    let t = Instant::now();
    let key = Arc::new(deserialize_server_key(key_hex).map_err(|e| (StatusCode::BAD_REQUEST, e))?);
    println!("[FHE Engine] Expanded + cached server key {}… ({:.1}s)", &computed[..12], t.elapsed().as_secs_f32());
    cache.insert(computed, key.clone());
    Ok(key)
}

// ── Wire format ────────────────────────────────────────────────────────────────
// The engine no longer holds the client key and no longer decrypts. It returns the
// *encrypted* trigger result (hex of a RadixCiphertext encoding 1=triggered / 0=not).
// The browser decrypts it locally with its client key, which never leaves the device.

#[derive(Deserialize)]
pub struct EvaluationPayload {
    strategy_type: String,
    encrypted_upper_bound: String,
    encrypted_lower_bound: String,
    /// Full key hex; optional when `server_key_hash` hits the cache.
    #[serde(default)]
    server_key: Option<String>,
    /// sha256 of the key hex — cache reference (see KeyCache).
    #[serde(default)]
    server_key_hash: Option<String>,
    current_price_cents: u64,  // u64 — u32 overflows at ~$42k (BTC/ETH prices)
    // Public current unix time (seconds). Used by TWAP_SLICE to compare against an encrypted
    // fire-time so a TWAP slice's schedule stays in ciphertext (never plaintext on the server).
    // Defaults to 0 for older clients / price-only strategies.
    #[serde(default)]
    current_time: u64,
}

#[derive(Serialize)]
pub struct EvaluationResponse {
    /// Hex of the result RadixCiphertext (1=triggered, 0=not). None on error.
    #[serde(skip_serializing_if = "Option::is_none")]
    encrypted_result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl EvaluationResponse {
    fn ok(encrypted_result: String) -> Self {
        Self { encrypted_result: Some(encrypted_result), error: None }
    }
    fn err(msg: String) -> Self {
        Self { encrypted_result: None, error: Some(msg) }
    }
}

fn deserialize_hex<T: for<'de> serde::Deserialize<'de>>(hex_str: &str, label: &str) -> Result<T, String> {
    let bytes = hex::decode(hex_str)
        .map_err(|e| format!("hex decode failed for {}: {}", label, e))?;
    bincode::deserialize(&bytes)
        .map_err(|e| format!("bincode deserialize failed for {}: {}", label, e))
}

fn serialize_hex(ct: &RadixCiphertext) -> Result<String, String> {
    bincode::serialize(ct)
        .map(hex::encode)
        .map_err(|e| format!("bincode serialize failed for result: {}", e))
}

/// Deserialize the user's server key. The browser now sends a *compressed* server key
/// (~20MB hex vs ~200MB expanded), so we deserialize that and decompress. Older clients
/// (legacy payload-generator) sent an already-expanded `ServerKey`; we fall back to that
/// format so both wire formats keep working.
fn deserialize_server_key(hex_str: &str) -> Result<ServerKey, String> {
    let bytes = hex::decode(hex_str)
        .map_err(|e| format!("hex decode failed for server_key: {}", e))?;
    match bincode::deserialize::<CompressedServerKey>(&bytes) {
        Ok(compressed) => Ok(ServerKey::from(compressed)),
        Err(compressed_err) => bincode::deserialize::<ServerKey>(&bytes).map_err(|expanded_err| {
            format!(
                "server_key deserialize failed (compressed: {}; expanded: {})",
                compressed_err, expanded_err
            )
        }),
    }
}

/// Convenience: build an error tuple.
fn bad(code: StatusCode, msg: String) -> (StatusCode, Json<EvaluationResponse>) {
    (code, Json(EvaluationResponse::err(msg)))
}

/// Shared strategy dispatch — used by /evaluateStrategy and /evaluateBatch.
fn eval_strategy_core(
    sks: &ServerKey,
    strategy_type: &str,
    upper_hex: &str,
    lower_hex: &str,
    price: u64,
    current_time: u64,
) -> Result<RadixCiphertext, String> {
    match strategy_type {
        "LIMIT_ORDER" | "BRACKET_ORDER_SHORT" => {
            let enc_upper: RadixCiphertext = deserialize_hex(upper_hex, "upper_bound")?;
            let enc_lower: RadixCiphertext = deserialize_hex(lower_hex, "lower_bound")?;
            let is_above = fhe_core::homomorphic_check(sks, &enc_upper, "GTE", price)?;
            let is_below = fhe_core::homomorphic_check(sks, &enc_lower, "LTE", price)?;
            Ok(fhe_core::homomorphic_or(sks, &is_above, &is_below))
        }
        "LIMIT_BUY_DIP" => {
            let enc_lower: RadixCiphertext = deserialize_hex(lower_hex, "lower_bound")?;
            fhe_core::homomorphic_check(sks, &enc_lower, "LTE", price)
        }
        "LIMIT_SELL_RALLY" => {
            let enc_upper: RadixCiphertext = deserialize_hex(upper_hex, "upper_bound")?;
            fhe_core::homomorphic_check(sks, &enc_upper, "GTE", price)
        }
        // TWAP slice: time trigger, not price. The encrypted_lower_bound holds this slice's
        // fire-time (unix seconds), encrypted under the user's key. We fire when the *public*
        // current time has reached it — `enc_fire_time <= current_time` — which is exactly the
        // "GTE" comparison (bound <= scalar) but with current_time as the scalar instead of
        // price. The cadence therefore stays hidden in ciphertext, like a price threshold.
        "TWAP_SLICE" => {
            let enc_fire_time: RadixCiphertext = deserialize_hex(lower_hex, "fire_time")?;
            fhe_core::homomorphic_check(sks, &enc_fire_time, "GTE", current_time)
        }
        other => Err(format!("Unknown strategy_type '{}'", other)),
    }
}

pub async fn evaluate_strategy(
    State(cache): State<KeyCache>,
    Json(payload): Json<EvaluationPayload>,
) -> (StatusCode, Json<EvaluationResponse>) {
    println!("[FHE Engine] Evaluating strategy_type='{}' current_price_cents={}",
        payload.strategy_type, payload.current_price_cents);

    let server_key = match resolve_server_key(&cache, payload.server_key_hash.as_deref(), payload.server_key.as_deref()) {
        Ok(k) => k,
        Err((code, e)) => return bad(code, e),
    };

    let encrypted_result = match eval_strategy_core(
        &server_key, &payload.strategy_type, &payload.encrypted_upper_bound,
        &payload.encrypted_lower_bound, payload.current_price_cents, payload.current_time,
    ) {
        Ok(v) => v,
        Err(e) => {
            println!("[FHE Engine] ❌ {}", e);
            return bad(StatusCode::BAD_REQUEST, e);
        }
    };

    match serialize_hex(&encrypted_result) {
        Ok(hex) => {
            println!("[FHE Engine] ✅ Evaluation complete, returning encrypted result ({} hex chars)", hex.len());
            (StatusCode::OK, Json(EvaluationResponse::ok(hex)))
        },
        Err(e) => bad(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

#[derive(Deserialize)]
pub struct ConditionPayload {
    encrypted_bound: String,
    condition: String,          // "GTE" or "LTE"
    current_price_cents: u64,
    #[serde(default)]
    server_key: Option<String>,
    #[serde(default)]
    server_key_hash: Option<String>,
}

pub async fn evaluate_condition(
    State(cache): State<KeyCache>,
    Json(payload): Json<ConditionPayload>,
) -> (StatusCode, Json<EvaluationResponse>) {
    println!("[FHE Engine] evaluateCondition condition='{}' price_cents={}",
        payload.condition, payload.current_price_cents);

    let server_key = match resolve_server_key(&cache, payload.server_key_hash.as_deref(), payload.server_key.as_deref()) {
        Ok(k) => k,
        Err((code, e)) => return bad(code, e),
    };

    let enc_bound: RadixCiphertext = match deserialize_hex(&payload.encrypted_bound, "encrypted_bound") {
        Ok(v) => v,
        Err(e) => return bad(StatusCode::BAD_REQUEST, e),
    };

    let result = match fhe_core::homomorphic_check(
        &server_key, &enc_bound, &payload.condition, payload.current_price_cents
    ) {
        Ok(v) => v,
        Err(e) => return bad(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    match serialize_hex(&result) {
        Ok(hex) => (StatusCode::OK, Json(EvaluationResponse::ok(hex))),
        Err(e) => bad(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

#[cfg(test)]
mod key_cache_tests {
    use super::*;
    use tfhe::integer::gen_keys_radix;
    use tfhe::shortint::parameters::PARAM_MESSAGE_2_CARRY_2_KS_PBS;

    // 1-block keygen keeps this test fast; the cache is block-count-agnostic.
    fn make_key_hex() -> String {
        let (cks, _) = gen_keys_radix(PARAM_MESSAGE_2_CARRY_2_KS_PBS, 1);
        let compressed = CompressedServerKey::new_radix_compressed_server_key(cks.as_ref());
        hex::encode(bincode::serialize(&compressed).unwrap())
    }

    #[test]
    fn resolve_miss_insert_hit_and_428() {
        let cache = KeyCache::default();
        let key_hex = make_key_hex();
        let hash = hex::encode(Sha256::digest(key_hex.as_bytes()));

        // ServerKey has no Debug impl, so no unwrap_err() here.
        let status = |r: Result<Arc<ServerKey>, (StatusCode, String)>| match r {
            Ok(_) => panic!("expected an error"),
            Err((code, _)) => code,
        };

        // No hash, no key → 428
        assert_eq!(status(resolve_server_key(&cache, None, None)), StatusCode::PRECONDITION_REQUIRED);

        // Unknown hash, no key → 428
        assert_eq!(status(resolve_server_key(&cache, Some(&hash), None)), StatusCode::PRECONDITION_REQUIRED);

        // Full key → expands and caches
        let k1 = resolve_server_key(&cache, None, Some(&key_hex)).unwrap();

        // Hash-only now hits, returning the SAME cached instance (no re-expansion)
        let k2 = resolve_server_key(&cache, Some(&hash), None).unwrap();
        assert!(Arc::ptr_eq(&k1, &k2), "hash lookup must return the cached key");

        // Garbage key bytes → BAD_REQUEST, not a panic
        assert_eq!(status(resolve_server_key(&cache, None, Some("deadbeef"))), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn lru_eviction_respects_cap() {
        std::env::set_var("FHE_KEY_CACHE_CAP", "2");
        let cache = KeyCache::default();
        let (cks, _) = gen_keys_radix(PARAM_MESSAGE_2_CARRY_2_KS_PBS, 1);
        let compressed = CompressedServerKey::new_radix_compressed_server_key(cks.as_ref());
        let key = Arc::new(ServerKey::from(compressed));

        cache.insert("a".into(), key.clone());
        cache.insert("b".into(), key.clone());
        cache.get("a"); // touch "a" so "b" is now least-recently-used
        cache.insert("c".into(), key.clone());

        assert!(cache.get("a").is_some(), "recently-used entry must survive");
        assert!(cache.get("b").is_none(), "LRU entry must be evicted at cap");
        assert!(cache.get("c").is_some());
        std::env::remove_var("FHE_KEY_CACHE_CAP");
    }
}

// ── Condition trees ─────────────────────────────────────────────────────────────
// Boolean composition (AND/OR/NOT) used to happen in Python over plaintext booleans.
// Now that results are encrypted, the whole tree must be folded homomorphically here.

#[derive(Deserialize)]
pub struct TreePayload {
    tree: Value,
    #[serde(default)]
    server_key: Option<String>,
    #[serde(default)]
    server_key_hash: Option<String>,
    /// price_feed_id -> current price in cents
    prices: HashMap<String, u64>,
}

fn eval_tree_node(
    sks: &ServerKey,
    node: &Value,
    prices: &HashMap<String, u64>,
) -> Result<RadixCiphertext, String> {
    let op = node.get("op").and_then(|v| v.as_str())
        .ok_or_else(|| "tree node missing 'op'".to_string())?;

    match op {
        "LEAF" => {
            let bound_hex = node.get("encrypted_bound").and_then(|v| v.as_str())
                .ok_or_else(|| "LEAF missing 'encrypted_bound'".to_string())?;
            let condition = node.get("condition").and_then(|v| v.as_str())
                .ok_or_else(|| "LEAF missing 'condition'".to_string())?;
            let feed = node.get("price_feed_id").and_then(|v| v.as_str())
                .ok_or_else(|| "LEAF missing 'price_feed_id'".to_string())?;
            let price = *prices.get(feed)
                .ok_or_else(|| format!("no price for feed '{}'", feed))?;
            let enc_bound: RadixCiphertext = deserialize_hex(bound_hex, "encrypted_bound")?;
            fhe_core::homomorphic_check(sks, &enc_bound, condition, price)
        }
        "AND" | "OR" => {
            let children = node.get("conditions").and_then(|v| v.as_array())
                .filter(|c| !c.is_empty())
                .ok_or_else(|| format!("{} node has no 'conditions'", op))?;
            let mut acc = eval_tree_node(sks, &children[0], prices)?;
            for child in &children[1..] {
                let next = eval_tree_node(sks, child, prices)?;
                acc = if op == "AND" {
                    fhe_core::homomorphic_and(sks, &acc, &next)
                } else {
                    fhe_core::homomorphic_or(sks, &acc, &next)
                };
            }
            Ok(acc)
        }
        "NOT" => {
            let children = node.get("conditions").and_then(|v| v.as_array())
                .filter(|c| !c.is_empty())
                .ok_or_else(|| "NOT node has no 'conditions'".to_string())?;
            let inner = eval_tree_node(sks, &children[0], prices)?;
            Ok(fhe_core::homomorphic_not(sks, &inner))
        }
        other => Err(format!("unknown tree op '{}'", other)),
    }
}

// ── Batch evaluation ────────────────────────────────────────────────────────────
// One POST per scheduler tick instead of one per strategy: keys must already be cached
// (hash-only jobs); jobs are evaluated in parallel with rayon, one strategy per core.

#[derive(Deserialize)]
pub struct BatchJob {
    id: String,
    #[serde(default)]
    server_key_hash: Option<String>,
    /// Tree job when present; strategy job otherwise.
    #[serde(default)]
    tree: Option<Value>,
    #[serde(default)]
    strategy_type: Option<String>,
    #[serde(default)]
    encrypted_upper_bound: String,
    #[serde(default)]
    encrypted_lower_bound: String,
    #[serde(default)]
    current_price_cents: u64,
    #[serde(default)]
    current_time: u64,
}

#[derive(Deserialize)]
pub struct BatchPayload {
    #[serde(default)]
    prices: HashMap<String, u64>,
    jobs: Vec<BatchJob>,
}

#[derive(Serialize)]
pub struct BatchResponse {
    /// job id -> encrypted result hex
    results: HashMap<String, String>,
    /// job id -> error message (isolated per job)
    errors: HashMap<String, String>,
    /// key hashes the cache didn't have — caller re-runs those jobs individually
    /// via the single endpoints (whose 428 path uploads the key)
    missing_keys: Vec<String>,
}

pub async fn evaluate_batch(
    State(cache): State<KeyCache>,
    Json(payload): Json<BatchPayload>,
) -> (StatusCode, Json<BatchResponse>) {
    let n_jobs = payload.jobs.len();
    let t0 = Instant::now();

    // Resolve keys up front (cheap map lookups); batch jobs are hash-only by design.
    let mut errors: HashMap<String, String> = HashMap::new();
    let mut missing: Vec<String> = Vec::new();
    let mut runnable: Vec<(BatchJob, Arc<ServerKey>)> = Vec::new();
    for job in payload.jobs {
        match resolve_server_key(&cache, job.server_key_hash.as_deref(), None) {
            Ok(key) => runnable.push((job, key)),
            Err((_, msg)) => {
                if let Some(h) = &job.server_key_hash {
                    if !missing.contains(h) {
                        missing.push(h.clone());
                    }
                }
                errors.insert(job.id, msg);
            }
        }
    }

    let prices = Arc::new(payload.prices);
    // FHE work is CPU-bound: run the whole batch off the async runtime, jobs in parallel.
    let results: Vec<(String, Result<String, String>)> = tokio::task::spawn_blocking(move || {
        use rayon::prelude::*;
        runnable
            .into_par_iter()
            .map(|(job, key)| {
                let outcome = if let Some(tree) = &job.tree {
                    eval_tree_node(&key, tree, &prices)
                } else {
                    eval_strategy_core(
                        &key,
                        job.strategy_type.as_deref().unwrap_or(""),
                        &job.encrypted_upper_bound,
                        &job.encrypted_lower_bound,
                        job.current_price_cents,
                        job.current_time,
                    )
                };
                (job.id, outcome.and_then(|ct| serialize_hex(&ct)))
            })
            .collect()
    })
    .await
    .unwrap_or_default();

    let mut ok: HashMap<String, String> = HashMap::new();
    for (id, outcome) in results {
        match outcome {
            Ok(hex) => { ok.insert(id, hex); }
            Err(e) => { errors.insert(id, e); }
        }
    }
    println!(
        "[FHE Engine] evaluateBatch: {} jobs -> {} ok, {} errors, {} missing keys in {:.0}ms",
        n_jobs, ok.len(), errors.len(), missing.len(), t0.elapsed().as_millis()
    );
    (StatusCode::OK, Json(BatchResponse { results: ok, errors, missing_keys: missing }))
}

pub async fn evaluate_tree(
    State(cache): State<KeyCache>,
    Json(payload): Json<TreePayload>,
) -> (StatusCode, Json<EvaluationResponse>) {
    println!("[FHE Engine] evaluateTree with {} price feeds", payload.prices.len());

    let server_key = match resolve_server_key(&cache, payload.server_key_hash.as_deref(), payload.server_key.as_deref()) {
        Ok(k) => k,
        Err((code, e)) => return bad(code, e),
    };

    let result = match eval_tree_node(&server_key, &payload.tree, &payload.prices) {
        Ok(v) => v,
        Err(e) => return bad(StatusCode::BAD_REQUEST, e),
    };

    match serialize_hex(&result) {
        Ok(hex) => (StatusCode::OK, Json(EvaluationResponse::ok(hex))),
        Err(e) => bad(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}
