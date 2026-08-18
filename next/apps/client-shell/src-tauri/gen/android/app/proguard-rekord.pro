# I metodi del ponte con la WebView li chiama solo JavaScript: R8 non vede nessuna
# chiamata e in release li butterebbe via, lasciando la notifica senza dati.
-keepclasseswithmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
