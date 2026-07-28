import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { i18n } from "./lib/i18n.svelte";
import { applyTheme, loadUserPrefs } from "./lib/userPrefs";

const prefs = loadUserPrefs();
applyTheme(prefs.theme, prefs.customTheme);
i18n.applySaved();

mount(App, { target: document.getElementById("app")! });
