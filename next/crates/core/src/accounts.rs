//! Local multi-account registry (parity with old `.kord/global_info/accounts.json`).
//!
//! Layout under `data_dir`:
//! - `accounts.json` — registry
//! - `accounts/{id}/library-selection.json` — per-account library selection

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const DEFAULT_ACCOUNT_ID: &str = "default";
pub const DEFAULT_ACCOUNT_NAME: &str = "Locale";
const ACCOUNTS_SCHEMA: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountsFile {
    schema_version: u32,
    accounts: Vec<Account>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsSnapshot {
    pub default_account_id: String,
    pub accounts: Vec<Account>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_account_id: Option<String>,
}

fn safe_account_id(account_id: &str) -> Option<String> {
    let id = account_id.trim();
    if id.is_empty() {
        return None;
    }
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        None
    } else {
        Some(safe)
    }
}

fn clean_account_name(value: &str, fallback: &str) -> String {
    let t = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = t.trim();
    if t.is_empty() {
        fallback.to_string()
    } else {
        t.chars().take(80).collect()
    }
}

pub fn accounts_registry_path(data_dir: &Path) -> PathBuf {
    data_dir.join("accounts.json")
}

pub fn account_dir(data_dir: &Path, account_id: &str) -> Option<PathBuf> {
    safe_account_id(account_id).map(|id| data_dir.join("accounts").join(id))
}

pub fn account_library_selection_path(data_dir: &Path, account_id: &str) -> Option<PathBuf> {
    account_dir(data_dir, account_id).map(|d| d.join("library-selection.json"))
}

fn normalize_accounts(raw: &[Account]) -> Vec<Account> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for item in raw {
        let id = safe_account_id(&item.id).unwrap_or_else(|| Uuid::new_v4().to_string());
        if !seen.insert(id.clone()) {
            continue;
        }
        let fallback = if id == DEFAULT_ACCOUNT_ID {
            DEFAULT_ACCOUNT_NAME
        } else {
            "Account"
        };
        out.push(Account {
            id,
            name: clean_account_name(&item.name, fallback),
        });
    }
    out
}

fn write_accounts_file(data_dir: &Path, accounts: &[Account]) -> Result<()> {
    fs::create_dir_all(data_dir)?;
    let path = accounts_registry_path(data_dir);
    let body = AccountsFile {
        schema_version: ACCOUNTS_SCHEMA,
        accounts: accounts.to_vec(),
    };
    let raw = serde_json::to_string_pretty(&body)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &raw)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

fn read_accounts_file(data_dir: &Path) -> Result<Option<Vec<Account>>> {
    let path = accounts_registry_path(data_dir);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let parsed: AccountsFile = serde_json::from_str(&raw).unwrap_or(AccountsFile {
        schema_version: ACCOUNTS_SCHEMA,
        accounts: Vec::new(),
    });
    let list = normalize_accounts(&parsed.accounts);
    if list.is_empty() {
        Ok(None)
    } else {
        Ok(Some(list))
    }
}

/// Ensure registry + default account dir exist; migrate legacy global selection once.
pub fn ensure_accounts(data_dir: &Path) -> Result<Vec<Account>> {
    fs::create_dir_all(data_dir)?;
    let mut accounts = match read_accounts_file(data_dir)? {
        Some(list) => list,
        None => {
            let def = vec![Account {
                id: DEFAULT_ACCOUNT_ID.to_string(),
                name: DEFAULT_ACCOUNT_NAME.to_string(),
            }];
            write_accounts_file(data_dir, &def)?;
            def
        }
    };

    // Always keep a default id present as first account when missing.
    if !accounts.iter().any(|a| a.id == DEFAULT_ACCOUNT_ID) {
        accounts.insert(
            0,
            Account {
                id: DEFAULT_ACCOUNT_ID.to_string(),
                name: DEFAULT_ACCOUNT_NAME.to_string(),
            },
        );
        write_accounts_file(data_dir, &accounts)?;
    }

    for acc in &accounts {
        ensure_account_layout(data_dir, &acc.id, acc.id == DEFAULT_ACCOUNT_ID)?;
    }

    migrate_legacy_global_selection(data_dir)?;
    Ok(accounts)
}

fn ensure_account_layout(data_dir: &Path, account_id: &str, is_default: bool) -> Result<()> {
    let Some(dir) = account_dir(data_dir, account_id) else {
        bail!("invalid account id");
    };
    fs::create_dir_all(&dir)?;
    let Some(sel_path) = account_library_selection_path(data_dir, account_id) else {
        bail!("invalid account id");
    };
    if !sel_path.exists() {
        // New non-default accounts start empty; default gets includeAll when no prior file.
        let body = if is_default {
            serde_json::json!({
                "version": 1,
                "includeAll": true,
                "artists": [],
                "albums": [],
                "tracks": []
            })
        } else {
            serde_json::json!({
                "version": 1,
                "includeAll": false,
                "artists": [],
                "albums": [],
                "tracks": []
            })
        };
        let tmp = sel_path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&body)?)?;
        fs::rename(&tmp, &sel_path)?;
    }
    Ok(())
}

/// Move `data_dir/library-selection.json` → default account dir (once).
fn migrate_legacy_global_selection(data_dir: &Path) -> Result<()> {
    let legacy = data_dir.join("library-selection.json");
    if !legacy.is_file() {
        return Ok(());
    }
    let Some(dest) = account_library_selection_path(data_dir, DEFAULT_ACCOUNT_ID) else {
        return Ok(());
    };
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    // Prefer legacy content (existing user data) over the bootstrap empty/default file.
    if dest.exists() {
        let _ = fs::remove_file(&dest);
    }
    fs::rename(&legacy, &dest).or_else(|_| {
        fs::copy(&legacy, &dest)?;
        fs::remove_file(&legacy)?;
        Ok::<(), anyhow::Error>(())
    })?;
    Ok(())
}

pub fn get_accounts_snapshot(data_dir: &Path) -> Result<AccountsSnapshot> {
    let accounts = ensure_accounts(data_dir)?;
    Ok(AccountsSnapshot {
        default_account_id: DEFAULT_ACCOUNT_ID.to_string(),
        accounts,
        created_account_id: None,
    })
}

pub fn resolve_account_id(data_dir: &Path, requested: Option<&str>) -> Result<String> {
    let accounts = ensure_accounts(data_dir)?;
    let req = requested.map(str::trim).filter(|s| !s.is_empty());
    if let Some(id) = req {
        if accounts.iter().any(|a| a.id == id) {
            return Ok(id.to_string());
        }
        // Unknown id → fall back to default (compat with absent/stale clients).
    }
    Ok(accounts
        .first()
        .map(|a| a.id.clone())
        .unwrap_or_else(|| DEFAULT_ACCOUNT_ID.to_string()))
}

pub fn create_account(data_dir: &Path, name: &str) -> Result<AccountsSnapshot> {
    let mut accounts = ensure_accounts(data_dir)?;
    let id = Uuid::new_v4().to_string();
    let account = Account {
        id: id.clone(),
        name: clean_account_name(name, "Nuovo account"),
    };
    ensure_account_layout(data_dir, &account.id, false)?;
    accounts.push(account);
    write_accounts_file(data_dir, &accounts)?;
    Ok(AccountsSnapshot {
        default_account_id: DEFAULT_ACCOUNT_ID.to_string(),
        accounts,
        created_account_id: Some(id),
    })
}

pub fn update_account(data_dir: &Path, id: &str, name: Option<&str>) -> Result<AccountsSnapshot> {
    let mut accounts = ensure_accounts(data_dir)?;
    let account = accounts
        .iter_mut()
        .find(|a| a.id == id.trim())
        .with_context(|| format!("account not found: {id}"))?;
    if let Some(n) = name {
        account.name = clean_account_name(n, &account.name);
    }
    write_accounts_file(data_dir, &accounts)?;
    Ok(AccountsSnapshot {
        default_account_id: DEFAULT_ACCOUNT_ID.to_string(),
        accounts,
        created_account_id: None,
    })
}

pub fn delete_account(data_dir: &Path, id: &str) -> Result<AccountsSnapshot> {
    let account_id = id.trim();
    if account_id == DEFAULT_ACCOUNT_ID {
        bail!("cannot remove the default account");
    }
    let mut accounts = ensure_accounts(data_dir)?;
    if accounts.len() <= 1 {
        bail!("keep at least one account");
    }
    let before = accounts.len();
    accounts.retain(|a| a.id != account_id);
    if accounts.len() == before {
        bail!("account not found");
    }
    write_accounts_file(data_dir, &accounts)?;
    if let Some(dir) = account_dir(data_dir, account_id) {
        let _ = fs::remove_dir_all(dir);
    }
    Ok(AccountsSnapshot {
        default_account_id: DEFAULT_ACCOUNT_ID.to_string(),
        accounts,
        created_account_id: None,
    })
}

/// Account id from query `accountId` or headers (compat with old client).
pub fn account_id_from_headers_and_query(
    headers: &axum::http::HeaderMap,
    query_account_id: Option<&str>,
) -> Option<String> {
    if let Some(q) = query_account_id.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(q.to_string());
    }
    for name in ["x-rekord-account-id", "x-kord-account-id"] {
        if let Some(v) = headers.get(name).and_then(|h| h.to_str().ok()) {
            let t = v.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}
