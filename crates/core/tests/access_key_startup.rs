//! Fail closed: a `REKORD_ACCESS_KEY` that is set but empty or invalid stops
//! the hub from starting. Its own test binary (a single test) because it
//! changes the process environment.

use rekord_core::{prepare_hub_state, HubOptions};

#[test]
fn set_but_unusable_key_refuses_to_start() {
    let base = std::env::temp_dir().join(format!("rekord-ak-start-{}", uuid::Uuid::new_v4()));
    let opts = HubOptions {
        bind: "127.0.0.1:0".parse().unwrap(),
        data_dir: base.join("data"),
        client_ui_dir: None,
        admin_ui_dir: None,
    };
    let secretish = "tooshort-but-secret";
    for bad in [
        "",
        "   ",
        secretish,
        "has spaces in it but is long enough to pass",
        // Long enough, but weak: one repeated character, a repeated short block.
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "abababababababababababababababab",
    ] {
        std::env::set_var("REKORD_ACCESS_KEY", bad);
        let err = prepare_hub_state(&opts, None, None)
            .err()
            .unwrap_or_else(|| panic!("hub started with {bad:?}"))
            .to_string();
        assert!(err.contains("REKORD_ACCESS_KEY"), "{err}");
        assert!(!err.contains(secretish), "error echoes the key");
    }
    // Refused before the data dir is touched.
    assert!(!base.join("data").exists());

    std::env::set_var("REKORD_ACCESS_KEY", "tren-lago-nube-sal-mesa-ruido-faro");
    let state = prepare_hub_state(&opts, None, None).unwrap();
    assert!(state.access_key.is_set());

    std::env::remove_var("REKORD_ACCESS_KEY");
    let state = prepare_hub_state(&opts, None, None).unwrap();
    assert!(!state.access_key.is_set());
    drop(state);
    let _ = std::fs::remove_dir_all(&base);
}
