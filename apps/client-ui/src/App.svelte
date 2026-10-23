<script lang="ts" module>
  import { applyPlatformCapsToDom } from "./lib/platformCaps";

  // Before the first paint: CSS needs `data-rk-lowfx` on WebKitGTK from frame one.
  applyPlatformCapsToDom();
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import AccessKeyScreen from "./components/AccessKeyScreen.svelte";
  import AppShell from "./components/AppShell.svelte";
  import BootSplash from "./components/BootSplash.svelte";
  import ConnectScreen from "./components/ConnectScreen.svelte";
  import { getSelectedAccountId, setSelectedAccountId } from "./lib/account";
  import { connectGate } from "./lib/connect.svelte";
  import { getServerBaseUrl, setServerBaseUrl } from "./lib/config";
  import { t } from "./lib/i18n.svelte";
  import { player } from "./lib/player";
  import { session } from "./lib/session.svelte";

  /** The app boots only once, even when going through the connection flow. */
  let started = $state(false);

  function start() {
    if (started) return;
    started = true;
    // The gate may have just picked the local hub: the field in Settings must
    // show the address we are actually talking to.
    session.serverUrl = getServerBaseUrl();
    void session.bootstrap();
  }

  onMount(() => {
    const unbindPlayer = session.bindPlayer();
    const unbindWindow = session.bindWindow();
    void connectGate.decideOnStart().then((ready) => {
      // A hub that wants an access key starts the app once it is accepted.
      if (ready && connectGate.phase === "app") start();
    });
    return () => {
      unbindPlayer();
      unbindWindow();
    };
  });

  function onConnected(base: string, accountId: string) {
    setServerBaseUrl(base);
    session.serverUrl = base;
    connectGate.close();
    if (!started) {
      setSelectedAccountId(accountId);
      start();
      return;
    }
    // Flow reopened with the app running: switching account is not just writing
    // an id — the leaving account's preferences must be saved and theme,
    // exclusions and library selection reloaded. If it's the same account, a re-read is enough.
    if (accountId !== getSelectedAccountId()) void session.switchAccount(accountId);
    else void session.refreshAll();
  }

  function onKeyAccepted() {
    connectGate.keyAccepted();
    if (connectGate.phase !== "app") return;
    if (!started) start();
    else {
      void session.refreshAll();
      // A track that stopped on the refused key reloads with the new one.
      player.resumeAfterOutage();
    }
  }
</script>

{#if connectGate.phase === "connect"}
  <ConnectScreen
    savedBase={connectGate.savedBase}
    dismissible={started}
    onconnected={onConnected}
    ondismiss={() => connectGate.close()}
  />
{:else if connectGate.phase === "access-key" && !started}
  {@render keyScreen()}
{:else if connectGate.phase === "probing"}
  <!-- Startup probe, usually a few milliseconds: at first only the logo;
       bar and hints appear if the wait gets longer. -->
  <BootSplash />
{:else}
  <!-- A key asked for while the app runs (rotated on the hub, Settings ›
       Change) covers the app instead of replacing it: view, queue and player
       are still there once the key is accepted or the change cancelled. -->
  {@const keyOverlay = connectGate.phase === "access-key"}
  <div class="app-root" inert={keyOverlay} aria-hidden={keyOverlay ? "true" : undefined}>
    <AppShell />
  </div>
  {#if keyOverlay}
    <div class="key-overlay">
      {@render keyScreen()}
    </div>
  {/if}
{/if}

{#snippet keyScreen()}
  {#key connectGate.keyBase + connectGate.keyReason}
    <AccessKeyScreen
      base={connectGate.keyBase}
      reason={connectGate.keyReason}
      onaccepted={onKeyAccepted}
      oncancel={connectGate.keyCancellable ? () => connectGate.cancelKey() : undefined}
      cancelLabel={connectGate.keyCancellable ? t("connect.cancel") : undefined}
    />
  {/key}
{/snippet}

<style>
  .app-root {
    display: contents;
  }

  .key-overlay {
    position: fixed;
    inset: 0;
    z-index: 10000;
    overflow-y: auto;
  }
</style>
