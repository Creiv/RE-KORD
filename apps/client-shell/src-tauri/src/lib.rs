//! Tauri shell of the RE-KORD client.
//!
//! The UI is `apps/client-ui` bundled into the app; the hub is an HTTP(S)
//! address chosen on first launch. Only what the page can't do on its own lives
//! here: opening links in the system browser (opener plugin), saving a file
//! generated in the page (desktop), keeping a single instance open (desktop),
//! reading a QR code (phone) and — with the `hub` feature — running the hub itself.

#[cfg(desktop)]
mod downloads;
#[cfg(all(desktop, feature = "hub"))]
mod embedded_hub;
#[cfg(target_os = "linux")]
mod linux_env;
#[cfg(desktop)]
mod mpris;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First, before GTK, WebKit or any thread starts (see linux_env.rs).
    #[cfg(target_os = "linux")]
    linux_env::apply();

    let builder = tauri::Builder::default();

    // Must be registered first: the second process has to exit before
    // initializing the rest (and, with the embedded hub, before trying the port).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        focus_main_window(app);
    }));

    let builder = builder.plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .manage(mpris::MediaState::default())
        .manage(HubStartError::default())
        .invoke_handler(tauri::generate_handler![
            embedded_hub_error,
            downloads::save_download,
            mpris::media_update,
            mpris::media_clear,
            mpris::media_art
        ]);

    // The camera is only needed to read the hub's QR code on first launch, and only
    // where there is a camera: on desktop the address is typed on the keyboard.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    #[cfg(all(desktop, feature = "hub"))]
    let builder = builder.setup(|app| {
        embedded_hub::start(app.handle());
        Ok(())
    });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building RE-KORD client");

    app.run(|_app, _event| {
        #[cfg(all(desktop, feature = "hub"))]
        if let tauri::RunEvent::Exit = _event {
            embedded_hub::stop(_app);
        }
    });
}

/// Why the embedded hub did not start, as a code the page translates
/// (`access_key_config`). `None` when it started or is not part of this build.
#[cfg(desktop)]
#[derive(Default)]
pub(crate) struct HubStartError(pub(crate) std::sync::Mutex<Option<&'static str>>);

#[cfg(desktop)]
#[tauri::command]
fn embedded_hub_error(state: tauri::State<'_, HubStartError>) -> Option<&'static str> {
    *state.0.lock().unwrap()
}

#[cfg(desktop)]
fn focus_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
