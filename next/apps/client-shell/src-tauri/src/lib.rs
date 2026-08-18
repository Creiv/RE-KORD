#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_shell::init());
    // La fotocamera serve solo per leggere il QR dell'hub al primo avvio, e solo
    // dove una fotocamera c'e': sul desktop l'indirizzo si scrive con la tastiera.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .run(tauri::generate_context!())
        .expect("error while running RE-KORD client");
}
