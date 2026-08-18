<script lang="ts">
  import SectionNavTabs from "./SectionNavTabs.svelte";
  import UiIcon from "./icons/UiIcon.svelte";

  type Tab = { id: string; label: string };

  let {
    eyebrow = "",
    title = "",
    tabs,
    activeTab = "",
    tabsAriaLabel = "",
    ontab,
    back,
    icon,
    tools,
    children,
    class: className = "",
  }: {
    /** Small caps line above the title: where the user is. */
    eyebrow?: string;
    /** What this page currently holds — a name, a count, a selection. */
    title?: string;
    /** Section nav, rendered on its own row under the title. */
    tabs?: Tab[];
    activeTab?: string;
    tabsAriaLabel?: string;
    ontab?: (id: string) => void;
    /** Drill-down pages show a back button where the icon would be. */
    back?: { label: string; onclick: () => void };
    icon?: import("svelte").Snippet;
    tools?: import("svelte").Snippet;
    /** Extra row inside the toolbar card (filters, a second control strip). */
    children?: import("svelte").Snippet;
    /** Extra classes on the toolbar card, for per-page density tweaks. */
    class?: string;
  } = $props();

  const hasTabs = $derived(!!tabs?.length);
</script>

<header class="view-page__toolbar-band">
  <section
    class="rk-surface-card surface-card--toolbar-only page-toolbar-card {className}"
    class:page-toolbar-card--tabs={hasTabs}
  >
    <div class="section-head section-head--page-toolbar page-toolbar">
      <div class="section-head__lead" class:page-toolbar__lead--backrow={!!back}>
        {#if back}
          <button
            type="button"
            class="page-toolbar-back-ic"
            aria-label={back.label}
            title={back.label}
            onclick={back.onclick}
          >
            <UiIcon name="chevronLeft" class="page-toolbar-back-ic__ic" />
          </button>
        {:else if icon}
          <span class="section-head__icon-wrap" aria-hidden="true">
            {@render icon()}
          </span>
        {/if}
        <div class="section-head__text">
          {#if eyebrow}
            <p class="rk-eyebrow">{eyebrow}</p>
          {/if}
          {#if title}
            <h2>{title}</h2>
          {/if}
        </div>
      </div>
      {#if tools}
        <div class="section-head__tools page-toolbar__actions">
          {@render tools()}
        </div>
      {/if}
    </div>

    {#if tabs?.length}
      <nav class="page-toolbar__tabs">
        <SectionNavTabs
          {tabs}
          active={activeTab}
          size="nav"
          ariaLabel={tabsAriaLabel}
          onselect={(id) => ontab?.(id)}
        />
      </nav>
    {/if}

    {@render children?.()}
  </section>
</header>
