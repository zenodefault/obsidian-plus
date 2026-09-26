//! Contract test: every fixture in schemas/protocol/fixtures.jsonl must parse
//! according to its `valid` flag. Keeps Rust and TypeScript in lockstep.

use serde_json::Value;
use sovereign_core::protocol::Envelope;

fn fixtures_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../schemas/protocol/fixtures.jsonl")
}

fn load_fixtures() -> Vec<Value> {
    let raw = std::fs::read_to_string(fixtures_path()).expect("fixtures file exists");
    raw.lines()
        .filter(|l| !l.trim().is_empty() && !l.trim().starts_with('#'))
        .map(|l| serde_json::from_str(l).expect("fixture line is valid JSON"))
        .collect()
}

#[test]
fn all_fixtures_match_rust_protocol_types() {
    let fixtures = load_fixtures();
    assert!(
        fixtures.len() >= 5,
        "expected a meaningful fixture set, got {}",
        fixtures.len()
    );

    for fixture in &fixtures {
        let name = fixture["name"].as_str().unwrap_or("<unnamed>");
        let wire = fixture["wire"].to_string();
        let parsed: Result<Envelope, _> = serde_json::from_str(&wire);
        if fixture["valid"].as_bool().unwrap_or(true) {
            assert!(parsed.is_ok(), "fixture `{name}` should parse: {wire}");
            // Re-serialization must not invent fields.
            let reparsed = serde_json::from_str::<Envelope>(
                &serde_json::to_string(&parsed.unwrap()).unwrap(),
            );
            assert!(reparsed.is_ok(), "fixture `{name}` should round-trip");
        } else {
            assert!(parsed.is_err(), "fixture `{name}` should be rejected");
        }
    }
}
