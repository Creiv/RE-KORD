<script lang="ts">
  import { ActionRow, Banner, Button, Panel, QrCodeImg } from "@rekord/ui";
  import { admin, humanTime } from "../lib/admin.svelte";

  const remote = $derived(admin.remote);
  const access = $derived(admin.access);
  const locked = $derived(admin.busy || !admin.canManage);
  const lanUrl = $derived(remote?.lanUrl?.trim() || "");
  const publicUrl = $derived(
    remote?.status === "running" ? remote?.publicUrl?.trim() || "" : "",
  );

  const statusLabel: Record<string, string> = {
    stopped: "spento",
    starting: "in avvio",
    running: "attivo",
    error: "errore",
  };
</script>

<Panel title="Accesso in rete locale">
  {#snippet actions()}
    <Button
      variant="secondary"
      disabled={admin.busy}
      onclick={() => void admin.loadSection("network")}
    >
      Aggiorna
    </Button>
  {/snippet}

  {#if remote}
    <div class="grid">
      <div class="cell">
        <span class="k">Indirizzo in rete locale</span>
        <span class="v">{remote.lanUrl ?? "—"}</span>
      </div>
      <div class="cell">
        <span class="k">Ascolto su</span><span class="v">{remote.bind}</span>
      </div>
      <div class="cell">
        <span class="k">Pannello hub</span><span class="v">{remote.lanUrl ?? ""}/admin</span>
      </div>
    </div>
    <p class="hint">
      Da telefono o da un altro computer apri l'indirizzo in rete locale: il
      client web e le API rispondono sulla stessa porta.
    </p>
    {#if lanUrl}
      <!-- Il QR è per l'app Android: al primo avvio chiede l'indirizzo dell'hub,
           e leggerlo da qui evita di copiare un IP a mano sul telefono. -->
      <figure class="qr">
        <QrCodeImg value={lanUrl} size={220} alt={`QR code per aprire ${lanUrl}`} />
        <figcaption>Inquadra dall'app RE-KORD per collegare il telefono</figcaption>
      </figure>
    {/if}
  {/if}
</Panel>

<Panel title="Accesso da fuori casa">
  {#if remote}
    <div class="grid">
      <div class="cell">
        <span class="k">Tunnel</span>
        <span class="v">{statusLabel[remote.status] ?? remote.status}</span>
      </div>
      <div class="cell">
        <span class="k">Indirizzo pubblico</span>
        <span class="v">{remote.publicUrl ?? "—"}</span>
      </div>
      <div class="cell">
        <span class="k">Avviato</span><span class="v">{humanTime(remote.startedAt)}</span>
      </div>
      <div class="cell">
        <span class="k">cloudflared</span>
        <span class="v">{remote.cloudflaredAvailable ? "disponibile" : "non trovato"}</span>
      </div>
      <div class="cell">
        <span class="k">Login Cloudflare</span>
        <span class="v">{remote.cloudflareLoggedIn ? "eseguito" : "non eseguito"}</span>
      </div>
      <div class="cell">
        <span class="k">IP pubblico</span><span class="v">{admin.publicIp ?? "—"}</span>
      </div>
    </div>

    {#if publicUrl}
      <figure class="qr">
        <QrCodeImg value={publicUrl} size={220} alt={`QR code per aprire ${publicUrl}`} />
        <figcaption>Inquadra da fuori casa per collegare il telefono</figcaption>
      </figure>
    {/if}

    {#if remote.error}
      <Banner tone="error">{remote.error}</Banner>
    {/if}
    {#if !remote.cloudflaredAvailable}
      <Banner tone="info">
        Installa <code>cloudflared</code> per aprire un tunnel temporaneo, oppure
        imposta <code>REKORD_PUBLIC_URL</code> se usi già un tuo indirizzo.
      </Banner>
    {/if}

    <ActionRow>
      {#if remote.status === "running" || remote.status === "starting"}
        <Button variant="secondary" disabled={locked} onclick={() => void admin.remoteStop()}>
          Ferma tunnel
        </Button>
      {:else}
        <Button disabled={locked} onclick={() => void admin.remoteStart()}>
          Avvia tunnel
        </Button>
      {/if}
      {#if remote.cloudflareLoggedIn}
        <Button variant="ghost" disabled={locked} onclick={() => void admin.remoteLogout()}>
          Esci da Cloudflare
        </Button>
      {:else}
        <Button variant="ghost" disabled={locked} onclick={() => void admin.remoteLogin()}>
          Accedi a Cloudflare
        </Button>
      {/if}
      <Button variant="ghost" disabled={admin.busy} onclick={() => void admin.loadPublicIp()}>
        Leggi IP pubblico
      </Button>
    </ActionRow>
  {/if}
</Panel>

<Panel title="Operazioni di macchina">
  <p class="hint">
    Cartella musica, scansioni, credenziali, ripristini e tunnel si comandano da
    qui. Di norma servono l'account Default e questo computer; il tunnel non
    conta come locale.
  </p>
  {#if access}
    <div class="grid">
      <div class="cell">
        <span class="k">Account Default</span>
        <span class="v">{access.isDefaultAccount ? "sì" : "no"}</span>
      </div>
      <div class="cell">
        <span class="k">Richiesta locale</span>
        <span class="v">{access.local ? "sì" : "no"}</span>
      </div>
      <div class="cell">
        <span class="k">Puoi comandare l'hub</span>
        <span class="v">{access.canManageMachine ? "sì" : "no"}</span>
      </div>
    </div>
    <label class="check">
      <input
        type="checkbox"
        checked={access.allowRemoteAdmin}
        disabled={admin.busy || !access.local || !access.isDefaultAccount}
        onchange={(e) => void admin.setRemoteAdmin(e.currentTarget.checked)}
      />
      <span>
        Consenti queste operazioni anche da remoto (rete locale e tunnel)
      </span>
    </label>
    {#if !access.local}
      <Banner tone="info">
        Stai usando il pannello da remoto: l'interruttore si cambia solo dal
        computer dell'hub.
      </Banner>
    {/if}
  {/if}
</Panel>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
    gap: 0.55rem 1.1rem;
  }

  .cell {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
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
    margin: 0 0 0.8rem;
    color: var(--rk-muted);
    font-size: var(--rk-fs-sm);
    line-height: var(--rk-lh);
  }

  .check {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
    margin: 0.8rem 0 0;
    line-height: var(--rk-lh);
  }

  .check input {
    margin-top: 0.2rem;
  }

  .qr {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.4rem;
    margin: 0.8rem 0 0;
  }

  .qr :global(img) {
    display: block;
    width: min(180px, 46vw);
    height: auto;
    aspect-ratio: 1 / 1;
    padding: 0.5rem;
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius-lg);
    background: #fff;
  }

  .qr figcaption {
    color: var(--rk-muted);
    font-size: var(--rk-fs-xs);
    max-width: min(220px, 60vw);
    line-height: var(--rk-lh);
  }
</style>
