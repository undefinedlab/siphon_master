//! T0 local prover — PROTOCOL.md §7 / ARCHITECTURE-GREENFIELD.md §7.
//!
//! Loads a witness JSON fixture, runs the native spend guest, prints committed public
//! limbs and optional timing (reference validate — Circom Groth16 is the product prove).

use std::fs;
use std::io::{self, Read};
use std::path::PathBuf;
use std::time::Instant;

use clap::Parser;
use spend_core::validate_witness_public;
use spend_core::witness::SpendWitness;
use spend_guest::run_guest_json;

#[derive(Parser, Debug)]
#[command(name = "siphon-prove", about = "Siphon v3 local spend prover (T0 native guest)")]
struct Args {
    /// Witness JSON path (PROTOCOL.md §3 layout). Use `-` to read JSON from stdin (no disk copy).
    #[arg(short, long)]
    witness: PathBuf,

    /// Repeat validation N times and report median wall time (benchmark mode).
    #[arg(long, default_value_t = 1)]
    bench_iters: u32,

    /// When set, assert witness `expectedPublic` matches guest commit (if present).
    #[arg(long, default_value_t = true)]
    check_expected: bool,
}

fn read_witness_json(path: &PathBuf) -> Result<String, Box<dyn std::error::Error>> {
    if path.as_os_str() == "-" {
        let mut buf = String::new();
        io::stdin().read_to_string(&mut buf)?;
        return Ok(buf);
    }
    Ok(fs::read_to_string(path)?)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let json = read_witness_json(&args.witness)?;
    let witness: SpendWitness = serde_json::from_str(&json)?;

    let mut times = Vec::new();
    let mut last = None;
    for _ in 0..args.bench_iters {
        let start = Instant::now();
        last = Some(run_guest_json(&json)?);
        times.push(start.elapsed());
    }
    let out = last.expect("at least one iteration");

    if args.check_expected && !witness.expected_public.is_empty() {
        let expected: [String; spend_core::PUBLIC_WIDTH] = witness
            .expected_public
            .clone()
            .try_into()
            .map_err(|_| "expectedPublic must have PUBLIC_WIDTH limbs")?;
        validate_witness_public(&witness, &expected)?;
    }

    let limbs_json = serde_json::to_string_pretty(&out.committed.limbs)?;
    println!("{limbs_json}");

    if args.bench_iters > 1 {
        times.sort();
        let med = times[times.len() / 2];
        eprintln!(
            "bench: {} iters, median {:?}, guest=native",
            args.bench_iters, med
        );
    }

    Ok(())
}
