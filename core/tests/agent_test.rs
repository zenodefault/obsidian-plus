//! Part 8 tests: policy engine (§61), planner (§59), operations with
//! approval + version checking (§62–64), rollback (§65), audit chain (§66),
//! and the §103 agent-safety matrix over stdio.

use serde_json::json;
use sovereign_core::agent::operations::{self, AgentFileInput};
use sovereign_core::agent::policy::{tool_by_name, Decision, PolicyEngine, Permission};
use sovereign_core::agent::{audit, planner::PlanParams};
use sovereign_core::indexing::NoteIndex;
use sovereign_core::ipc::{read_envelope, write_envelope};
use sovereign_core::protocol::{Envelope, ErrorCode};
use sovereign_core::vault::manager::hash_content;
use std::io::{BufReader, Write};
use std::process::{Child, Command, Stdio};

fn index() -> NoteIndex {
    let dir = std::env::temp_dir().join(format!(
        "sv-agent-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    NoteIndex::open(&dir).unwrap()
}

// ---------- §61 policy engine ----------

#[test]
fn policy_default_matrix() {
    assert_eq!(PolicyEngine::decision(Permission::VaultRead), Decision::Allow);
    assert_eq!(PolicyEngine::decision(Permission::KnowledgeSearch), Decision::Allow);
    assert_eq!(PolicyEngine::decision(Permission::MemoryPropose), Decision::Allow);
    assert_eq!(PolicyEngine::decision(Permission::VaultModify), Decision::Confirm);
    assert_eq!(PolicyEngine::decision(Permission::VaultCreate), Decision::Confirm);
    assert_eq!(PolicyEngine::decision(Permission::VaultMove), Decision::Confirm);
    assert_eq!(PolicyEngine::decision(Permission::VaultDelete), Decision::Denied);
}

#[test]
fn tool_registry_has_no_arbitrary_execution() {
    for tool in sovereign_core::agent::TOOLS {
        // §60: no shell, no arbitrary code, no unrestricted filesystem.
        assert!(!tool.name.contains("shell") && !tool.name.contains("exec") && !tool.name.contains("python"));
        if tool.mutates {
            // Every mutating tool is gated: confirm at minimum, delete never.
            assert_ne!(
                PolicyEngine::decision(tool.permission),
                Decision::Allow,
                "{} mutates but is not gated",
                tool.name
            );
        }
    }
    assert_eq!(tool_by_name("vault.delete").unwrap().permission, Permission::VaultDelete);
    assert!(tool_by_name("agent.self_modify").is_none());
}

// ---------- §62–63 operations: prepare + approve ----------

#[test]
fn operation_lifecycle_prepare_approve_execute_verify() {
    let idx = index();
    let conn = idx.connection();
    let new_content = "# Created\n\nFresh body.";
    let op = operations::prepare(
        conn,
        "Create a summary note",
        None,
        vec![AgentFileInput {
            path: "Summaries/New.md".into(),
            action: "create".into(),
            content: Some(new_content.into()),
            old_content: None,
            new_path: None,
        }],
    )
    .unwrap();
    assert_eq!(op.approval_status, "pending");
    assert_eq!(op.status, "pending");
    assert_eq!(op.files.len(), 1);
    assert_eq!(op.files[0].new_hash.as_deref(), Some(hash_content(new_content).as_str()));

    // Execute before approval → PERMISSION_DENIED.
    let err = operations::execute(conn, &op.id, &[]).unwrap_err();
    assert!(matches!(err, operations::AgentApiError::PermissionDenied(_)));

    operations::approve(conn, &op.id).unwrap();

    // Create: path must still be absent. Reporting the new hash → conflict.
    let conflict = operations::execute(
        conn,
        &op.id,
        &[("Summaries/New.md".into(), hash_content(new_content))],
    )
    .unwrap_err();
    assert!(matches!(conflict, operations::AgentApiError::VersionConflict { .. }));

    let (executed, apply) = operations::execute(conn, &op.id, &[]).unwrap();
    assert_eq!(executed.status, "executed");
    assert_eq!(apply[0].action, "create");
    assert_eq!(apply[0].content.as_deref(), Some(new_content));

    // Verify with the hash the plugin would report after applying.
    let msg = operations::verify_applied(
        conn,
        &op.id,
        &[("Summaries/New.md".into(), hash_content(new_content))],
    )
    .unwrap();
    assert_eq!(msg, "verified");

    // Double execution is refused.
    let err2 = operations::execute(conn, &op.id, &[]).unwrap_err();
    assert!(matches!(err2, operations::AgentApiError::Invalid(_)));
}

#[test]
fn edit_operations_carry_rollback_payload_and_refuse_noop() {
    let idx = index();
    let conn = idx.connection();
    let old = "Original text.";
    let new = "Edited text.";
    let err = operations::prepare(
        conn,
        "noop edit",
        None,
        vec![AgentFileInput {
            path: "A.md".into(),
            action: "edit".into(),
            content: Some(old.into()),
            old_content: Some(old.into()),
            new_path: None,
        }],
    )
    .unwrap_err();
    assert!(err.to_string().contains("would not change"));

    let op = operations::prepare(
        conn,
        "edit note",
        None,
        vec![AgentFileInput {
            path: "A.md".into(),
            action: "edit".into(),
            content: Some(new.into()),
            old_content: Some(old.into()),
            new_path: None,
        }],
    )
    .unwrap();
    assert_eq!(op.files[0].old_hash.as_deref(), Some(hash_content(old).as_str()));

    operations::approve(conn, &op.id).unwrap();

    // Version check (§64): stale hash → FILE_VERSION_CONFLICT mapping tested
    // at dispatch; here the engine refuses with VersionConflict.
    let stale = operations::execute(
        conn,
        &op.id,
        &[("A.md".into(), hash_content("user changed it meanwhile"))],
    )
    .unwrap_err();
    assert!(matches!(stale, operations::AgentApiError::VersionConflict { .. }));

    let (_, apply) = operations::execute(conn, &op.id, &[("A.md".into(), hash_content(old))]).unwrap();
    assert_eq!(apply[0].content.as_deref(), Some(new));

    // Rollback (§65): current content must match post-state.
    let conflict = operations::rollback(
        conn,
        &op.id,
        &[("A.md".into(), hash_content("user edited after the operation"))],
    )
    .unwrap_err();
    assert!(matches!(conflict, operations::AgentApiError::VersionConflict { .. }));

    let (rolled, undo) = operations::rollback(conn, &op.id, &[("A.md".into(), hash_content(new))]).unwrap();
    assert_eq!(rolled.status, "rolled_back");
    assert_eq!(undo[0].content.as_deref(), Some(old), "rollback restores pre-state");
}

#[test]
fn deletes_are_refused_and_reject_closes_operations() {
    let idx = index();
    let conn = idx.connection();
    // §61/§103: unauthorized (or any) delete = 0.
    let err = operations::prepare(
        conn,
        "delete a note",
        None,
        vec![AgentFileInput {
            path: "Victim.md".into(),
            action: "delete".into(),
            content: None,
            old_content: None,
            new_path: None,
        }],
    )
    .unwrap_err();
    assert!(matches!(err, operations::AgentApiError::PermissionDenied(_)));

    let op = operations::prepare(
        conn,
        "create then reject",
        None,
        vec![AgentFileInput {
            path: "R.md".into(),
            action: "create".into(),
            content: Some("body".into()),
            old_content: None,
            new_path: None,
        }],
    )
    .unwrap();
    let rejected = operations::reject(conn, &op.id).unwrap();
    assert_eq!(rejected.approval_status, "rejected");
    assert_eq!(rejected.status, "rejected");
    // Executing a rejected operation is impossible.
    let err2 = operations::execute(conn, &op.id, &[]).unwrap_err();
    assert!(matches!(err2, operations::AgentApiError::PermissionDenied(_)));
}

// ---------- §59 planner ----------

#[test]
fn planner_proposes_link_operations_deterministically() {
    let idx = index();
    idx.upsert_note("Concepts/Alpha.md", "Alpha is a starting point.", 1, 30).unwrap();
    idx.upsert_note("Notes/One.md", "This discusses alpha extensively.", 2, 33).unwrap();
    idx.upsert_note("Notes/Two.md", "Unrelated content entirely.", 3, 27).unwrap();

    let plan = sovereign_core::agent::planner::plan(
        idx.connection(),
        &PlanParams {
            request: "link notes about alpha".into(),
            link_target: Some("Concepts/Alpha.md".into()),
            merge_paths: None,
            merge_target: None,
        },
    )
    .unwrap();
    // Notes/One mentions alpha; Notes/Two does not; Alpha itself is excluded.
    assert_eq!(plan.files.len(), 1);
    assert_eq!(plan.files[0].path, "Notes/One.md");
    assert!(plan.files[0].content.as_deref().unwrap().contains("[[Alpha]]"));
    // Planning never mutates the vault state: still just a proposal.
    let notes: i64 = idx.connection().query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
    assert_eq!(notes, 3);
}

#[test]
fn planner_refuses_ungrounded_requests() {
    let idx = index();
    let err = sovereign_core::agent::planner::plan(
        idx.connection(),
        &PlanParams {
            request: "reorganize everything".into(),
            link_target: None,
            merge_paths: None,
            merge_target: None,
        },
    )
    .unwrap_err();
    assert!(err.to_string().contains("no organization opportunities"));
    // Unknown merge target refused.
    let err2 = sovereign_core::agent::planner::plan(
        idx.connection(),
        &PlanParams {
            request: "merge stuff".into(),
            link_target: None,
            merge_paths: Some(vec!["A.md".into()]),
            merge_target: Some("Missing.md".into()),
        },
    )
    .unwrap_err();
    assert!(err2.to_string().contains("not found"));
}

#[test]
fn merge_plan_keeps_sources_and_prepends_heading() {
    let idx = index();
    idx.upsert_note("Target.md", "Target body.", 1, 12).unwrap();
    idx.upsert_note("Dup.md", "Duplicate body.", 2, 15).unwrap();
    let plan = sovereign_core::agent::planner::plan(
        idx.connection(),
        &PlanParams {
            request: "consolidate duplicates".into(),
            link_target: None,
            merge_paths: Some(vec!["Dup.md".into()]),
            merge_target: Some("Target.md".into()),
        },
    )
    .unwrap();
    let content = plan.files[0].content.as_deref().unwrap();
    assert!(content.contains("## From Dup"), "merged section header");
    assert!(content.contains("Duplicate body."));
    let rationale = plan.rationale.join("; ");
    assert!(rationale.contains("not deleted"), "§61: sources are never deleted");
}

// ---------- §66 audit chain ----------

#[test]
fn audit_chain_appends_and_verifies() {
    let idx = index();
    let conn = idx.connection();
    for i in 0..5 {
        audit::append(conn, None, "test", Some(&format!("event {i}")), None, None, "test.event").unwrap();
    }
    let events = audit::list(conn, 100).unwrap();
    assert_eq!(events.len(), 5);
    // Chain linkage: each event references the previous hash.
    for w in events.windows(2) {
        assert_eq!(w[1].previous_hash.as_deref(), Some(w[0].new_hash.as_str()));
    }
    assert!(audit::verify_chain(conn).unwrap());
}

#[test]
fn audit_chain_detects_tampering() {
    let idx = index();
    let conn = idx.connection();
    audit::append(conn, None, "test", Some("legit"), None, None, "x").unwrap();
    audit::append(conn, None, "test", Some("legit2"), None, None, "x").unwrap();
    // Tamper with the first event's result.
    conn.execute(
        "UPDATE audit_events SET result = 'forged' WHERE rowid = 1",
        [],
    )
    .unwrap();
    assert!(!audit::verify_chain(conn).unwrap());
}

// ---------- stdio integration: §103 agent-safety matrix ----------

struct CoreProc {
    child: Child,
}

impl CoreProc {
    fn spawn() -> Self {
        let tmp = std::env::temp_dir().join(format!(
            "sovereign-agent-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let bin = env!("CARGO_BIN_EXE_sovereign-core");
        let child = Command::new(bin)
            .arg("--data-dir")
            .arg(&tmp)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn core");
        Self { child }
    }

    fn request(&mut self, env: &Envelope) -> Envelope {
        let stdin = self.child.stdin.as_mut().unwrap();
        write_envelope(stdin, env).unwrap();
        let stdout = self.child.stdout.as_mut().unwrap();
        let mut reader = BufReader::new(stdout);
        read_envelope(&mut reader).unwrap().expect("core replied")
    }
}

impl Drop for CoreProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn full_agent_cycle_over_stdio() {
    let mut core = CoreProc::spawn();

    // Sync two notes through the normal flow.
    let one = "# One\n\nThis discusses alpha extensively.";
    let alpha = "# Alpha\n\nAlpha is a concept.";
    let mut sync = |core: &mut CoreProc, path: &str, content: &str, prefix: &str| {
        let reply = core.request(&Envelope::request(format!("{prefix}b"), "vault.sync.begin", json!({})));
        let session = reply.result.unwrap()["session_id"].as_str().unwrap().to_string();
        core.request(&Envelope::request(
            format!("{prefix}c"),
            "vault.sync.batch",
            json!({
                "session_id": session,
                "notes": [{"path": path, "hash": hash_content(content), "mtime": 1, "size": content.len()}],
            }),
        ));
        core.request(&Envelope::request(
            format!("{prefix}m"),
            "vault.sync.commit",
            json!({"session_id": session}),
        ));
        core.request(&Envelope::request(
            format!("{prefix}n"),
            "vault.sync.note",
            json!({
                "session_id": session,
                "path": path,
                "hash": hash_content(content),
                "mtime": 1,
                "size": content.len(),
                "content": content,
            }),
        ));
        core.request(&Envelope::request(
            format!("{prefix}f"),
            "vault.sync.finish",
            json!({"session_id": session}),
        ));
    };
    sync(&mut core, "Concepts/Alpha.md", alpha, "a");
    sync(&mut core, "Notes/One.md", one, "b");

    // 1. Tool registry exposes the §61 matrix.
    let reply = core.request(&Envelope::request("t1", "agent.tools", json!({})));
    let tools = reply.result.unwrap()["tools"].as_array().unwrap().clone();
    assert!(tools.len() >= 10);
    let delete = tools.iter().find(|t| t["name"] == "vault.delete").unwrap();
    assert_eq!(delete["decision"], "denied");
    let edit = tools.iter().find(|t| t["name"] == "vault.edit").unwrap();
    assert_eq!(edit["decision"], "confirm");

    // 2. Plan → proposed link operation.
    let reply = core.request(&Envelope::request(
        "t2",
        "agent.plan",
        json!({"request": "link alpha notes", "link_target": "Concepts/Alpha.md"}),
    ));
    let plan = reply.result.expect("plan result")["plan"].clone();
    assert_eq!(plan["files"].as_array().unwrap().len(), 1);
    assert_eq!(plan["files"][0]["path"], "Notes/One.md");
    let rationale = plan["rationale"].as_array().unwrap();
    assert!(!rationale.is_empty(), "preview includes the WHY (§63)");

    // 3. Create operation from the plan (edit One.md with the link added).
    let reply = core.request(&Envelope::request(
        "t3",
        "agent.create",
        json!({
            "request": "add alpha link to One.md",
            "files": [{
                "path": "Notes/One.md",
                "action": "edit",
                "content": format!("{one}\n\nRelated: [[Alpha]]"),
                "old_content": one,
            }],
        }),
    ));
    let op = reply.result.expect("create result")["operation"].clone();
    let op_id = op["id"].as_str().unwrap().to_string();
    assert_eq!(op["approval_status"], "pending");

    // 4. Execute without approval → PERMISSION_DENIED (§103 escalation).
    let reply = core.request(&Envelope::request(
        "t4",
        "agent.execute",
        json!({"id": op_id, "current": [{"path": "Notes/One.md", "hash": hash_content(one)}]}),
    ));
    assert_eq!(reply.error.expect("denied").code, ErrorCode::PermissionDenied);

    // 5. Approve, then execute with a STALE hash → FILE_VERSION_CONFLICT (§64).
    core.request(&Envelope::request("t5", "agent.approve", json!({"id": op_id})));
    let reply = core.request(&Envelope::request(
        "t6",
        "agent.execute",
        json!({"id": op_id, "current": [{"path": "Notes/One.md", "hash": hash_content("tampered") }]}),
    ));
    assert_eq!(reply.error.expect("conflict").code, ErrorCode::FileVersionConflict);

    // 6. Execute with the true hash → apply instructions; plugin applies.
    let new_content = format!("{one}\n\nRelated: [[Alpha]]");
    let reply = core.request(&Envelope::request(
        "t7",
        "agent.execute",
        json!({"id": op_id, "current": [{"path": "Notes/One.md", "hash": hash_content(one)}]}),
    ));
    let exec = reply.result.expect("execute result");
    assert_eq!(exec["operation"]["status"], "executed");
    assert_eq!(exec["apply"][0]["content"], json!(new_content));

    // 7. Verify with post-apply hashes.
    let reply = core.request(&Envelope::request(
        "t8",
        "agent.verify",
        json!({"id": op_id, "applied": [{"path": "Notes/One.md", "hash": hash_content(&new_content)}]}),
    ));
    assert_eq!(reply.result.expect("verify")["message"], "verified");

    // 8. Rollback with wrong current hash → FILE_VERSION_CONFLICT (§65).
    let reply = core.request(&Envelope::request(
        "t9",
        "agent.rollback",
        json!({"id": op_id, "current": [{"path": "Notes/One.md", "hash": hash_content("moved on")}]}),
    ));
    assert_eq!(reply.error.expect("rollback conflict").code, ErrorCode::FileVersionConflict);

    // 9. Rollback with post-state hash → restore instructions.
    let reply = core.request(&Envelope::request(
        "t10",
        "agent.rollback",
        json!({"id": op_id, "current": [{"path": "Notes/One.md", "hash": hash_content(&new_content)}]}),
    ));
    let rolled = reply.result.expect("rollback result");
    assert_eq!(rolled["operation"]["status"], "rolled_back");
    assert_eq!(rolled["apply"][0]["content"], json!(one));

    // 10. Delete request is refused at the door (§103: dangerous delete).
    let reply = core.request(&Envelope::request(
        "t11",
        "agent.create",
        json!({
            "request": "delete the victim",
            "files": [{"path": "Notes/One.md", "action": "delete"}],
        }),
    ));
    assert_eq!(reply.error.expect("delete refused").code, ErrorCode::PermissionDenied);

    // 11. Audit trail is complete and the chain verifies.
    let reply = core.request(&Envelope::request("t12", "activity.list", json!({"limit": 50})));
    let audit = reply.result.expect("audit result");
    assert_eq!(audit["chain_valid"], true);
    let events = audit["events"].as_array().unwrap();
    let results: Vec<&str> = events.iter().filter_map(|e| e["result"].as_str()).collect();
    assert!(results.contains(&"operation.prepared"));
    assert!(results.contains(&"operation.approved"));
    assert!(results.contains(&"operation.executed"));
    assert!(results.contains(&"operation.verified"));
    assert!(results.contains(&"operation.rolled_back"));

    // 12. operation.get / operation.list round trip.
    let reply = core.request(&Envelope::request("t13", "operation.get", json!({"id": op_id})));
    assert_eq!(reply.result.expect("get")["operation"]["id"], json!(op_id));
    let reply = core.request(&Envelope::request("t14", "operation.list", json!({})));
    assert!(reply.result.expect("list")["operations"].as_array().unwrap().len() >= 1);

    // 13. Unknown operation id → typed INVALID_PARAMS.
    let reply = core.request(&Envelope::request("t15", "agent.approve", json!({"id": "nope"})));
    assert_eq!(reply.error.expect("not found").code, ErrorCode::InvalidParams);

    core.request(&Envelope::request("t16", "core.shutdown", json!({})));
}
