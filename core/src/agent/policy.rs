//! Permission policy engine (PLAN.md §61).
//!
//! The default matrix: reads and searches are allowed, vault mutations
//! require explicit confirmation (approval of a previewed operation), and
//! deletes are hard-disabled. There is deliberately no API that mutates this
//! table — the AI cannot change its own permissions (§61), and enforcement
//! lives here, outside any model (§67).

use serde::{Deserialize, Serialize};

/// Every permission in the §61 table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Permission {
    #[serde(rename = "knowledge.read")]
    KnowledgeRead,
    #[serde(rename = "knowledge.search")]
    KnowledgeSearch,
    #[serde(rename = "memory.read")]
    MemoryRead,
    #[serde(rename = "memory.propose")]
    MemoryPropose,
    #[serde(rename = "memory.write")]
    MemoryWrite,
    #[serde(rename = "vault.read")]
    VaultRead,
    #[serde(rename = "vault.create")]
    VaultCreate,
    #[serde(rename = "vault.modify")]
    VaultModify,
    #[serde(rename = "vault.move")]
    VaultMove,
    #[serde(rename = "vault.delete")]
    VaultDelete,
}

impl Permission {
    pub fn as_str(&self) -> &'static str {
        match self {
            Permission::KnowledgeRead => "knowledge.read",
            Permission::KnowledgeSearch => "knowledge.search",
            Permission::MemoryRead => "memory.read",
            Permission::MemoryPropose => "memory.propose",
            Permission::MemoryWrite => "memory.write",
            Permission::VaultRead => "vault.read",
            Permission::VaultCreate => "vault.create",
            Permission::VaultModify => "vault.modify",
            Permission::VaultMove => "vault.move",
            Permission::VaultDelete => "vault.delete",
        }
    }
}

/// What the policy says about a permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Automatic (read-only paths).
    Allow,
    /// Only with explicit user approval of a previewed operation (§63).
    Confirm,
    /// Never, regardless of approval (§61: delete DISABLED).
    Denied,
}

/// Deterministic policy evaluation (§104 Rule 7: no AI in security decisions).
pub struct PolicyEngine;

impl PolicyEngine {
    pub fn decision(permission: Permission) -> Decision {
        match permission {
            Permission::KnowledgeRead
            | Permission::KnowledgeSearch
            | Permission::MemoryRead
            | Permission::MemoryPropose
            | Permission::VaultRead => Decision::Allow,
            Permission::MemoryWrite
            | Permission::VaultCreate
            | Permission::VaultModify
            | Permission::VaultMove => Decision::Confirm,
            Permission::VaultDelete => Decision::Denied,
        }
    }
}

/// One capability in the agent's tool registry (§60). No unrestricted shell,
/// no arbitrary code execution, no arbitrary filesystem access.
#[derive(Debug, Clone, Copy)]
pub struct Tool {
    pub name: &'static str,
    pub permission: Permission,
    /// True when the tool changes the vault (and therefore needs an
    /// operation + approval to run).
    pub mutates: bool,
}

/// The registry (§60). `vault.*` tools are executed by the plugin after
/// approval; read tools resolve against the core's derived state.
pub const TOOLS: &[Tool] = &[
    Tool { name: "vault.search", permission: Permission::KnowledgeSearch, mutates: false },
    Tool { name: "vault.read", permission: Permission::KnowledgeRead, mutates: false },
    Tool { name: "vault.create", permission: Permission::VaultCreate, mutates: true },
    Tool { name: "vault.edit", permission: Permission::VaultModify, mutates: true },
    Tool { name: "vault.move", permission: Permission::VaultMove, mutates: true },
    Tool { name: "vault.delete", permission: Permission::VaultDelete, mutates: true },
    Tool { name: "knowledge.search", permission: Permission::KnowledgeSearch, mutates: false },
    Tool { name: "memory.search", permission: Permission::MemoryRead, mutates: false },
    Tool { name: "relationship.find", permission: Permission::KnowledgeSearch, mutates: false },
    Tool { name: "contradiction.find", permission: Permission::MemoryRead, mutates: false },
    Tool { name: "operation.preview", permission: Permission::KnowledgeRead, mutates: false },
    Tool { name: "operation.rollback", permission: Permission::VaultModify, mutates: true },
    Tool { name: "audit.read", permission: Permission::KnowledgeRead, mutates: false },
];

pub fn tool_by_name(name: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|t| t.name == name)
}
