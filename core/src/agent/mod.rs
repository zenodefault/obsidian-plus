//! Agent & safety (PLAN.md §59–66): planner, tool registry, permission
//! policy, structured operations with approval + version checking, rollback
//! and the hash-chained audit log. Every state-changing action carries an
//! operation id (Rule 12); deletes are disabled (§61); the model never
//! touches the permission path (Rule 6, §67).

pub mod audit;
pub mod operations;
pub mod planner;
pub mod policy;

pub use audit::AuditEvent;
pub use operations::{AgentApiError, AgentFile, AgentFileInput, ApplyFile, Operation};
pub use planner::{Plan, PlanParams};
pub use policy::{Decision, Permission, PolicyEngine, Tool, TOOLS};
