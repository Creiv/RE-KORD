<script lang="ts">
  import PageToolbar from "../components/PageToolbar.svelte";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import AccountPanel from "../components/settings/AccountPanel.svelte";
  import InterfacePanel from "../components/settings/InterfacePanel.svelte";
  import LibraryPanel from "../components/settings/LibraryPanel.svelte";
  import NetworkPanel from "../components/settings/NetworkPanel.svelte";
  import SystemPanel from "../components/settings/SystemPanel.svelte";
  import { SettingsAccounts } from "../components/settings/settingsAccounts.svelte";
  import { t } from "../lib/i18n.svelte";
  import { tick } from "svelte";
  import { session, type SettingsSection } from "../lib/session.svelte";

  // Stable section ids (Italian) — labels are translated.
  const settingsTabs = $derived([
    { id: "Account", label: t("settings.tab.account") },
    { id: "Interfaccia", label: t("settings.tab.ui") },
    { id: "Libreria", label: t("settings.tab.library") },
    { id: "Rete", label: t("settings.tab.network") },
    { id: "Sistema", label: t("settings.tab.system") },
  ]);

  let section = $state<SettingsSection>("Interfaccia");

  // "Apri Impostazioni" elsewhere (Studio cookie hint, empty dashboard): open
  // the tab that holds the setting and bring its panel into view.
  $effect(() => {
    const target = session.settingsTarget;
    if (!target) return;
    session.settingsTarget = null;
    section = target.section;
    if (target.anchor === "integrations") {
      void tick().then(() =>
        document.querySelector(".settings-integrations-section")?.scrollIntoView({ block: "start" }),
      );
    }
  });

  /**
   * Shared by the panels. Each panel loads what it needs when it mounts (only
   * the active one is mounted), so switching tab fetches once per visit.
   */
  const ctx = new SettingsAccounts();

  // Another tab may rebind the account while this view is open.
  $effect(() => {
    const bound = session.activeAccountId;
    if (bound && bound !== ctx.selectedAccountId) ctx.selectedAccountId = bound;
  });
</script>

<div class="view-page settings-page">
  <PageToolbar
    eyebrow={t("settings.eyebrow")}
    title={t("page.settings.title")}
    tabs={settingsTabs}
    activeTab={section}
    tabsAriaLabel={t("settings.tabsAria")}
    ontab={(id) => (section = id as SettingsSection)}
  >
    {#snippet icon()}
      <UiIcon name="settings" class="section-head__ic" />
    {/snippet}
  </PageToolbar>

  <div class="settings-page__body">
    {#if section === "Account"}
      <AccountPanel {ctx} />
    {:else if section === "Interfaccia"}
      <InterfacePanel {ctx} />
    {:else if section === "Libreria"}
      <LibraryPanel {ctx} />
    {:else if section === "Rete"}
      <NetworkPanel {ctx} />
    {:else}
      <SystemPanel {ctx} />
    {/if}
  </div>
</div>
