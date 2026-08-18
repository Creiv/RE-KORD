/**
 * Il pacchetto non ha una build propria: lo compilano le app che lo importano.
 * Questo file serve a svelte-check, che altrimenti si ferma su ogni componente
 * condiviso senza controllarne i tipi.
 */
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
};
