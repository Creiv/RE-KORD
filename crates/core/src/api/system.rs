//! Machine operations switch and the access key (admin panel).

use super::*;

/// What the caller is allowed to do with host-level settings.
pub(super) async fn get_machine_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
) -> impl IntoResponse {
    ok(crate::perm::machine_op_status(&state, &headers, None, peer))
}

/// Allow machine operations from remote clients. Only settable locally.
pub(super) async fn set_machine_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<EnabledBody>,
) -> Response {
    let op = machine_op_or_err!(&state, &headers, peer);
    if !op.local {
        return crate::perm::forbidden(crate::perm::FORBIDDEN_REMOTE);
    }
    if let Err(e) = state
        .config
        .lock_or_recover()
        .save_allow_remote_admin(body.enabled)
    {
        return internal(e.to_string());
    }
    crate::diagnostics::log_activity(
        &data_dir(&state),
        if body.enabled {
            crate::diagnostics::ActivityEvent::new(
                "system",
                "remoteAdminOn",
                "operazioni di macchina abilitate da remoto",
            )
        } else {
            crate::diagnostics::ActivityEvent::new(
                "system",
                "remoteAdminOff",
                "operazioni di macchina limitate al computer dell'hub",
            )
        },
    );
    ok(crate::perm::machine_op_status(&state, &headers, None, peer)).into_response()
}

/// Whether the hub asks for an access key, and where that key comes from.
pub(super) fn access_key_status(state: &AppState) -> serde_json::Value {
    let source = state.access_key.source();
    json!({
        "enabled": source.is_some(),
        "source": source.map(|s| s.as_str()).unwrap_or("off"),
        // `REKORD_ACCESS_KEY` wins: the panel can look but not change.
        "lockedByEnv": source == Some(crate::access_key::KeySource::Env),
    })
}

pub(super) async fn get_access_key(State(state): State<AppState>) -> impl IntoResponse {
    ok(access_key_status(&state))
}

#[derive(Deserialize)]
pub(super) struct AccessKeyBody {
    key: String,
}

/// Set or replace the access key from the admin panel (machine operation).
/// The key is validated like `REKORD_ACCESS_KEY`, only its digest is saved,
/// and every client (this panel included) must present it from now on.
pub(super) async fn set_access_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
    Json(body): Json<AccessKeyBody>,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    if state.access_key.locked_by_env() {
        return err_code(
            StatusCode::CONFLICT,
            "access_key_from_env",
            "the access key is set by REKORD_ACCESS_KEY; change it there",
        );
    }
    let gate = match crate::access_key::AccessGate::from_user_input(body.key.trim()) {
        Ok(gate) => gate,
        // The message never contains the value (see `validate_key`).
        Err(e) => return err_code(StatusCode::BAD_REQUEST, "access_key_weak", e.to_string()),
    };
    let digest = gate.digest_hex();
    if let Err(e) = state
        .config
        .lock_or_recover()
        .save_access_key_digest(Some(&digest))
    {
        return internal(e.to_string());
    }
    state
        .access_key
        .set(gate, crate::access_key::KeySource::Settings);
    crate::diagnostics::log_activity(
        &data_dir(&state),
        crate::diagnostics::ActivityEvent::new(
            "system",
            "accessKeySet",
            "chiave di accesso impostata dal pannello",
        ),
    );
    ok(access_key_status(&state)).into_response()
}

/// Remove the access key set from the panel (machine operation): the hub is
/// open again to anyone who reaches it.
pub(super) async fn clear_access_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    PeerAddr(peer): PeerAddr,
) -> Response {
    let _op = machine_op_or_err!(&state, &headers, peer);
    if state.access_key.locked_by_env() {
        return err_code(
            StatusCode::CONFLICT,
            "access_key_from_env",
            "the access key is set by REKORD_ACCESS_KEY; unset it there",
        );
    }
    if let Err(e) = state.config.lock_or_recover().save_access_key_digest(None) {
        return internal(e.to_string());
    }
    state.access_key.clear();
    crate::diagnostics::log_activity(
        &data_dir(&state),
        crate::diagnostics::ActivityEvent::new(
            "system",
            "accessKeyCleared",
            "chiave di accesso rimossa dal pannello",
        ),
    );
    ok(access_key_status(&state)).into_response()
}
