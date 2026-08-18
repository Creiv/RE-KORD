<script lang="ts">
  import { ActionRow, Banner, Button, Field, Panel, TextInput } from "@rekord/ui";
  import { admin } from "../lib/admin.svelte";

  let cookieInput = $state<HTMLInputElement | null>(null);

  const cfg = $derived(admin.config);
  const locked = $derived(admin.busy || !admin.canManage);

  function onCookiePicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void admin.uploadCookies(file);
  }
</script>

<Panel title="YouTube (yt-dlp)">
  {#if cfg}
    <div class="state">
      <span class="k">Download</span>
      <span class="v">{cfg.ytdlpEnabled ? "disponibile" : "yt-dlp non trovato"}</span>
      <span class="k">Cookie</span>
      <span class="v">
        {cfg.youtubeCookiesConfigured
          ? (cfg.youtubeCookiesLabel || "configurati")
          : "non configurati"}
      </span>
    </div>
    {#if cfg.youtubeCookiesLockedByEnv}
      <Banner tone="info">
        I cookie arrivano da una variabile d'ambiente: modificali sul sistema.
      </Banner>
    {:else}
      <ActionRow>
        <Button
          disabled={locked || cfg.youtubeCookiesWritable === false}
          onclick={() => cookieInput?.click()}
        >
          Carica cookies.txt
        </Button>
        {#if cfg.youtubeCookiesConfigured}
          <Button
            variant="ghost"
            disabled={locked || cfg.youtubeCookiesWritable === false}
            onclick={() => void admin.clearCookies()}
          >
            Rimuovi
          </Button>
        {/if}
      </ActionRow>
    {/if}
    <input
      bind:this={cookieInput}
      class="hidden-file"
      type="file"
      accept=".txt,text/plain"
      onchange={onCookiePicked}
    />
    <p class="hint">
      I cookie servono per i contenuti con verifica dell'età o riservati agli
      abbonati. Esportali dal browser in formato Netscape.
    </p>
  {/if}
</Panel>

<Panel title="Discogs">
  {#if cfg}
    <div class="state">
      <span class="k">Token</span>
      <span class="v">
        {cfg.discogsTokenConfigured || cfg.discogsConfigured
          ? "configurato"
          : "non configurato"}
      </span>
    </div>
    {#if cfg.discogsLockedByEnv}
      <Banner tone="info">
        Il token arriva da una variabile d'ambiente: modificalo sul sistema.
      </Banner>
    {:else}
      <Field label="Token personale">
        <TextInput
          type="password"
          bind:value={admin.discogsToken}
          placeholder="Incolla il token Discogs"
          disabled={locked || cfg.discogsWritable === false}
        />
      </Field>
      <ActionRow>
        <Button
          disabled={locked || !admin.discogsToken.trim() || cfg.discogsWritable === false}
          onclick={() => void admin.saveDiscogsToken()}
        >
          Salva token
        </Button>
        {#if cfg.discogsTokenConfigured || cfg.discogsConfigured}
          <Button
            variant="ghost"
            disabled={locked || cfg.discogsWritable === false}
            onclick={() => void admin.clearDiscogsToken()}
          >
            Rimuovi
          </Button>
        {/if}
      </ActionRow>
    {/if}
    <p class="hint">
      Con il token attivo lo Studio può cercare edizioni, etichette e numeri di
      catalogo su Discogs.
    </p>
  {/if}
</Panel>

{#if !admin.canManage}
  <Banner tone="info">
    Le credenziali si modificano dal computer dell'hub con l'account Default.
  </Banner>
{/if}

<style>
  .state {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.3rem 0.8rem;
    align-items: baseline;
    margin-bottom: 0.8rem;
  }

  .k {
    font-size: var(--rk-fs-xs);
    color: var(--rk-muted);
  }

  .v {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .hint {
    margin: 0.7rem 0 0;
    color: var(--rk-muted);
    font-size: var(--rk-fs-sm);
    line-height: var(--rk-lh);
  }

  .hidden-file {
    display: none;
  }
</style>
