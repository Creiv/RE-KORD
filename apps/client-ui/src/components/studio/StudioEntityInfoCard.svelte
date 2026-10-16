<script lang="ts">
  /**
   * Studio → Metadati → Curiosità (legacy `StudioEntityInfoCard`): search the
   * web for curiosità about an artist and all its albums, or about selected
   * albums, then pick entry by entry what to save (text editable). Saved
   * entries are listed and can be removed one by one. The hub is addressed by
   * folder keys, never by display names.
   */
  import { Segmented } from "@rekord/ui";
  import { untrack } from "svelte";
  import UiIcon from "../icons/UiIcon.svelte";
  import type { Album, Artist } from "../../lib/api";
  import {
    entityInfoGet,
    entityInfoSave,
    entityInfoSearch,
    type EntityInfoCandidate,
    type EntityInfoSavedItem,
    type EntityInfoSourceReport,
  } from "../../lib/api/studio";
  import { confirmDialog } from "../../lib/confirm.svelte";
  import { i18n, t, tp } from "../../lib/i18n.svelte";
  import { session } from "../../lib/session.svelte";
  import { studioAccess } from "../../lib/studio/access.svelte";
  import { studioCodeText, studioErrorText } from "../../lib/studio/errors";
  import { toasts } from "../../lib/toasts.svelte";

  let {
    initialArtistId = null,
    onlog,
  }: {
    /** Pre-select this artist (the Metadati picker's choice). */
    initialArtistId?: number | null;
    onlog?: (kind: "info" | "ok" | "warn" | "error", text: string) => void;
  } = $props();

  type Row = {
    /** "artist" or the album folder key. */
    key: string;
    kind: "artist" | "album";
    label: string;
    albumDir: string | null;
    albumName: string | null;
    candidates: EntityInfoCandidate[];
    picked: boolean[];
    texts: string[];
    open: boolean;
    /** False for rows shown only to manage already-saved entries. */
    searched: boolean;
    sources: EntityInfoSourceReport[];
    error: string | null;
  };

  const SOURCE_NAMES: Record<string, string> = {
    wikipedia: "Wikipedia",
    wikiquote: "Wikiquote",
    lastfm: "Last.fm",
    "last.fm": "Last.fm",
    theaudiodb: "TheAudioDB",
    audiodb: "TheAudioDB",
    discogs: "Discogs",
    musicbrainz: "MusicBrainz",
  };
  const PREVIEW_CHARS = 180;
  const LOAD_CONCURRENCY = 4;

  let artistId = $state<number | null>(null);
  let scope = $state<"artist" | "albums">("artist");
  let selected = $state<Set<string>>(new Set());
  let rows = $state<Row[]>([]);
  let savedByKey = $state<Record<string, EntityInfoSavedItem[]>>({});
  let artistImage = $state<string | null>(null);
  /** Candidate thumbnail chosen as artist photo (artist row only). */
  let photoUrl = $state<string | null>(null);
  let busy = $state(false);
  let savingAll = $state(false);
  let progress = $state<{ cur: number; tot: number } | null>(null);
  let removing = $state<string | null>(null);
  let note = $state<string | null>(null);
  /** Bumped on every target change: late answers for an old target are dropped. */
  let generation = 0;

  $effect(() => {
    if (initialArtistId != null && artistId == null) artistId = initialArtistId;
  });

  const artistsSorted = $derived(
    session.artists
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, i18n.sortLocale, { numeric: true })),
  );
  const artist = $derived<Artist | null>(
    artistId != null ? (session.artists.find((a) => a.id === artistId) ?? null) : null,
  );
  const albums = $derived.by<Album[]>(() => {
    const a = artist;
    if (!a) return [];
    return session.allAlbums
      .filter((al) => !al.loose && al.folder_key && (al.artist_id === a.id || (al.artist_id == null && al.artist_name === a.name)))
      .slice()
      .sort((x, y) => x.name.localeCompare(y.name, i18n.sortLocale, { numeric: true }));
  });
  /** Artist folder: the first path segment its albums share (most common). */
  const artistDir = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const al of albums) {
      const head = al.folder_key.split("/")[0]?.trim();
      if (head) counts.set(head, (counts.get(head) ?? 0) + 1);
    }
    let best = "";
    let n = 0;
    for (const [k, c] of counts) {
      if (c > n) {
        best = k;
        n = c;
      }
    }
    return best || artist?.name || "";
  });

  function albumDirOf(al: Album): string {
    const slash = al.folder_key.indexOf("/");
    return slash >= 0 ? al.folder_key.slice(slash + 1) : al.folder_key;
  }

  function normText(s: string): string {
    return s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 140);
  }

  function sourceName(s: string | null | undefined): string {
    if (!s) return "";
    return SOURCE_NAMES[s.toLowerCase()] ?? s;
  }

  function preview(text: string): string {
    const s = text.replace(/\s+/g, " ").trim();
    if (s.length <= PREVIEW_CHARS) return s;
    const cut = s.slice(0, PREVIEW_CHARS);
    const at = cut.lastIndexOf(" ");
    return `${(at > 80 ? cut.slice(0, at) : cut).replace(/[,;:.!?…]+$/, "")}…`;
  }

  function savedLabel(item: EntityInfoSavedItem): string {
    return item.title?.trim() || preview(item.text);
  }

  function kindLabel(c: EntityInfoCandidate): string {
    if (c.title?.trim()) return c.title.trim();
    if (c.kind === "trivia") return t("studio.einfo.kindTrivia");
    if (c.kind === "bio") return t("studio.einfo.kindBio");
    if (c.kind === "quote") return t("studio.einfo.kindQuote");
    return t("studio.einfo.kindDesc");
  }

  function targetFor(key: string): Omit<Row, "candidates" | "picked" | "texts" | "open" | "searched" | "sources" | "error"> | null {
    if (key === "artist") {
      return artist
        ? { key, kind: "artist", label: artist.name, albumDir: null, albumName: null }
        : null;
    }
    const al = albums.find((a) => a.folder_key === key);
    return al
      ? { key, kind: "album", label: al.name, albumDir: albumDirOf(al), albumName: al.name }
      : null;
  }

  async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++]!;
        await fn(item);
      }
    });
    await Promise.all(workers);
  }

  /** Identity of the current target; library reloads that change nothing keep the rows. */
  const targetSig = $derived(
    `${artist?.id ?? ""}|${artistDir}|${i18n.locale}|${albums.map((a) => a.folder_key).join("\u0001")}`,
  );

  // New target (artist, its albums, language): drop everything from the old one.
  $effect(() => {
    targetSig;
    untrack(resetForTarget);
  });

  function resetForTarget() {
    const a = artist;
    const dir = artistDir;
    const list = albums;
    const gen = ++generation;
    selected = new Set();
    rows = [];
    savedByKey = {};
    artistImage = null;
    photoUrl = null;
    progress = null;
    note = null;
    busy = false;
    if (!a || !dir) return;
    const targets: Array<{ key: string; albumDir: string | null }> = [
      { key: "artist", albumDir: null },
      ...list.map((al) => ({ key: al.folder_key, albumDir: albumDirOf(al) })),
    ];
    const found: Record<string, EntityInfoSavedItem[]> = {};
    void mapLimit(targets, LOAD_CONCURRENCY, async (tg) => {
      try {
        const bundle = await entityInfoGet(dir, tg.albumDir);
        if (gen !== generation) return;
        found[tg.key] = bundle.items ?? [];
        if (tg.key === "artist") artistImage = bundle.image ?? null;
      } catch {
        found[tg.key] = [];
      }
    }).then(() => {
      if (gen !== generation) return;
      savedByKey = found;
      // Rows for targets that already have entries: removable without a search.
      if (!rows.length) {
        rows = targets
          .filter((tg) => (found[tg.key]?.length ?? 0) > 0)
          .map((tg) => targetFor(tg.key))
          .filter((r): r is NonNullable<typeof r> => !!r)
          .map((r) => ({
            ...r,
            candidates: [],
            picked: [],
            texts: [],
            open: false,
            searched: false,
            sources: [],
            error: null,
          }));
      }
    });
  }

  function savedKeys(key: string): Set<string> {
    return new Set((savedByKey[key] ?? []).map((it) => normText(it.text)));
  }

  function isDup(row: Row, i: number): boolean {
    const c = row.candidates[i];
    if (!c) return false;
    if (c.alreadySaved) return true;
    const keys = savedKeys(row.key);
    return keys.has(normText(row.texts[i] ?? c.text)) || keys.has(normText(c.text));
  }

  async function run() {
    const a = artist;
    if (!a || busy) return;
    const keys =
      scope === "artist"
        ? ["artist", ...albums.map((al) => al.folder_key)]
        : albums.filter((al) => selected.has(al.folder_key)).map((al) => al.folder_key);
    const targets = keys.map(targetFor).filter((r): r is NonNullable<typeof r> => !!r);
    if (!targets.length) return;
    const gen = generation;
    busy = true;
    note = null;
    rows = [];
    photoUrl = null;
    progress = { cur: 0, tot: targets.length };
    const acc: Row[] = [];
    let found = 0;
    let failed = 0;
    for (const [i, tg] of targets.entries()) {
      let candidates: EntityInfoCandidate[] = [];
      let sources: EntityInfoSourceReport[] = [];
      let error: string | null = null;
      try {
        const r = await entityInfoSearch({
          artist: a.name,
          album: tg.albumName,
          artistDir,
          albumDir: tg.albumDir,
          lang: i18n.locale,
        });
        candidates = r.candidates;
        sources = r.sources;
      } catch (e) {
        error = studioErrorText(e);
        failed += 1;
      }
      if (gen !== generation) return;
      found += candidates.length;
      const keysSaved = savedKeys(tg.key);
      const row: Row = {
        ...tg,
        candidates,
        // Pre-ticked, except entries already saved (no duplicates).
        picked: candidates.map((c) => !c.alreadySaved && !keysSaved.has(normText(c.text))),
        texts: candidates.map((c) => c.text),
        open: targets.length === 1,
        searched: true,
        sources,
        error,
      };
      if (tg.kind === "artist" && !artistImage) {
        photoUrl = candidates.find((c) => c.imageUrl)?.imageUrl ?? null;
      }
      acc.push(row);
      rows = [...acc];
      progress = { cur: i + 1, tot: targets.length };
    }
    busy = false;
    onlog?.(
      failed ? "warn" : "info",
      t("studio.einfo.logSearched", {
        found: tp("studio.einfo.foundCount", found),
        targets: tp("studio.einfo.targetsCount", targets.length),
      }),
    );
  }

  function patchRow(key: string, patch: Partial<Row>) {
    rows = rows.map((row) => (row.key === key ? { ...row, ...patch } : row));
  }

  async function removeSaved(row: Row, item: EntityInfoSavedItem) {
    if (!artist || removing) return;
    const label = savedLabel(item);
    const ok = await confirmDialog({
      title: t("studio.einfo.removeConfirmTitle"),
      message: t("studio.einfo.removeConfirmMessage", { label, target: row.label }),
      confirmLabel: t("studio.einfo.removeConfirmOk"),
      danger: true,
    });
    if (!ok || removing) return;
    removing = item.id;
    try {
      const bundle = await entityInfoSave({
        artist: artistDir,
        album: row.albumDir,
        removeIds: [item.id],
      });
      savedByKey = { ...savedByKey, [row.key]: bundle.items ?? [] };
      const done = t("studio.einfo.logRemoved", { label });
      toasts.ok(done, { key: "studio-einfo-removed" });
      onlog?.("info", done);
    } catch (e) {
      note = studioErrorText(e);
      toasts.error(note, { key: "studio-einfo-removed" });
      onlog?.("error", note);
    } finally {
      removing = null;
    }
  }

  async function saveAll() {
    if (!artist || savingAll) return;
    savingAll = true;
    note = null;
    let added = 0;
    let errors = 0;
    for (const row of rows) {
      const add = row.candidates
        .map((c, i) =>
          row.picked[i] && !isDup(row, i) && row.texts[i]?.trim()
            ? {
                lang: c.lang || i18n.locale,
                title: c.title ?? null,
                text: row.texts[i]!.trim(),
                source: c.source ?? null,
                url: c.url ?? null,
              }
            : null,
        )
        .filter((x): x is NonNullable<typeof x> => x !== null);
      const imageUrl = row.kind === "artist" ? photoUrl : null;
      if (!add.length && !imageUrl) continue;
      try {
        const bundle = await entityInfoSave({
          artist: artistDir,
          album: row.albumDir,
          add,
          imageUrl,
        });
        savedByKey = { ...savedByKey, [row.key]: bundle.items ?? [] };
        if (row.kind === "artist" && imageUrl) {
          const imageError = (bundle as { imageError?: unknown }).imageError;
          if (imageError) {
            const code = typeof imageError === "string" ? imageError : null;
            onlog?.("warn", t("studio.einfo.imageFailed", { error: studioCodeText(code, null) }));
          } else {
            artistImage = bundle.image ?? artistImage;
            photoUrl = null;
          }
        }
        added += typeof bundle.added === "number" ? bundle.added : add.length;
        patchRow(row.key, { picked: row.candidates.map(() => false), error: null });
      } catch (e) {
        errors += 1;
        patchRow(row.key, { error: studioErrorText(e), open: true });
      }
    }
    savingAll = false;
    note = errors
      ? tp("studio.einfo.savePartial", errors, { saved: tp("studio.einfo.savedEntries", added) })
      : tp("studio.einfo.savedEntries", added);
    onlog?.(errors ? "warn" : "ok", note);
  }

  const visibleRows = $derived(
    rows.filter((row) => row.searched || (savedByKey[row.key]?.length ?? 0) > 0),
  );
  const savable = $derived(
    rows.some(
      (row) =>
        row.picked.some((p, i) => p && !isDup(row, i) && row.texts[i]?.trim()) ||
        (row.kind === "artist" && photoUrl),
    ),
  );
</script>

<div class="studio-einfo">
  <div class="studio-einfo__intro">
    <span class="studio-action-group-label">{t("studio.einfo.label")}</span>
    <p class="subtle sm studio-hint-line">{t("studio.einfo.hint")}</p>
  </div>

  <div class="studio-einfo__controls">
    <label class="studio-einfo__artist">
      <span class="subtle sm block-label">{t("studio.einfo.artist")}</span>
      <select
        class="rk-select"
        value={artistId ?? ""}
        onchange={(e) => {
          const v = e.currentTarget.value;
          artistId = v ? Number(v) : null;
        }}
      >
        <option value="">{t("studio.einfo.pickArtist")}</option>
        {#each artistsSorted as a (a.id)}
          <option value={a.id}>{a.name}</option>
        {/each}
      </select>
    </label>
    <Segmented
      class="studio-einfo-scope"
      ariaLabel={t("studio.einfo.scopeAria")}
      value={scope}
      onchange={(v) => (scope = v === "albums" ? "albums" : "artist")}
      options={[
        { value: "artist", label: t("studio.einfo.scopeArtist") },
        { value: "albums", label: t("studio.einfo.scopeAlbums") },
      ]}
    />
  </div>

  {#if scope === "albums" && artist}
    {#if albums.length}
      <div class="studio-einfo-albums" role="group" aria-label={t("studio.einfo.albumsAria")}>
        {#each albums as al (al.folder_key)}
          <label class="studio-einfo-album-check">
            <input
              type="checkbox"
              checked={selected.has(al.folder_key)}
              onchange={(e) => {
                const next = new Set(selected);
                if (e.currentTarget.checked) next.add(al.folder_key);
                else next.delete(al.folder_key);
                selected = next;
              }}
            />
            <span class="studio-einfo-album-check__name">{al.name}</span>
            {#if savedByKey[al.folder_key]?.length}
              <em class="studio-einfo-existing">{tp("studio.einfo.savedCount", savedByKey[al.folder_key]!.length)}</em>
            {/if}
          </label>
        {/each}
      </div>
    {:else}
      <p class="subtle sm">{t("studio.einfo.noAlbums")}</p>
    {/if}
  {/if}

  <div class="studio-action-row studio-einfo-run">
    <button
      type="button"
      class="primary-btn"
      disabled={busy || !artist || (scope === "albums" && selected.size === 0)}
      onclick={() => void run()}
    >
      {busy ? t("studio.einfo.searching") : t("studio.einfo.search")}
    </button>
    {#if progress && busy}
      <span class="subtle sm studio-einfo-run__prog" role="status">
        {t("studio.einfo.progress", { cur: progress.cur, tot: progress.tot })}
      </span>
    {/if}
  </div>

  {#if visibleRows.length}
    <div class="studio-einfo-results">
      {#each visibleRows as row (row.key)}
        {@const saved = savedByKey[row.key] ?? []}
        {@const pickedCount = row.picked.filter((p, i) => p && !isDup(row, i)).length}
        <div class="studio-einfo-row" class:is-open={row.open}>
          <button
            type="button"
            class="studio-einfo-row__toggle"
            aria-expanded={row.open}
            onclick={() => patchRow(row.key, { open: !row.open })}
          >
            <span class="studio-einfo-row__label">
              {row.kind === "artist" ? t("studio.einfo.artistRow", { name: row.label }) : row.label}
            </span>
            <span class="studio-einfo-row__state subtle sm">
              {#if row.error}
                <span class="studio-einfo-row__err">{t("studio.einfo.rowFailed")}</span>
              {:else if !row.searched}
                {tp("studio.einfo.savedCount", saved.length)}
              {:else if row.candidates.length === 0}
                {t("studio.einfo.noResults")}
              {:else}
                {[
                  tp("studio.einfo.foundCount", row.candidates.length),
                  pickedCount ? tp("studio.einfo.pickedCount", pickedCount) : null,
                  saved.length ? tp("studio.einfo.savedCount", saved.length) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              {/if}
            </span>
            <UiIcon name="chevronRight" class="studio-einfo-row__chev{row.open ? ' is-open' : ''}" />
          </button>

          {#if row.open}
            <div class="studio-einfo-row__panel">
              {#if row.error}
                <p class="studio-einfo-row__error" role="alert">{row.error}</p>
              {/if}
              {#if row.sources.length}
                <ul class="studio-einfo-sources" aria-label={t("studio.einfo.sourcesAria")}>
                  {#each row.sources as s (s.source)}
                    <li class="studio-einfo-source" class:is-failed={!s.ok}>
                      <span class="studio-einfo-source__name">{sourceName(s.source)}</span>
                      {#if s.ok}
                        <span class="studio-einfo-source__state">
                          {s.count != null ? tp("studio.einfo.foundCount", s.count) : t("studio.einfo.sourceOk")}
                        </span>
                      {:else}
                        <span class="studio-einfo-source__state">{studioCodeText(s.code, s.message)}</span>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}

              {#if saved.length}
                <div class="studio-einfo-saved">
                  <span class="studio-einfo-sublabel">{t("studio.einfo.savedList")}</span>
                  {#each saved as item (item.id)}
                    <div class="studio-einfo-saved__row">
                      <span class="studio-einfo-saved__label" title={item.text}>{savedLabel(item)}</span>
                      {#if item.lang && item.lang !== i18n.locale}
                        <span class="studio-einfo-chip">{item.lang.toUpperCase()}</span>
                      {/if}
                      <button
                        type="button"
                        class="ghost-btn ghost-btn--sm studio-einfo-saved__rm"
                        disabled={!studioAccess.canWrite || removing === item.id}
                        title={studioAccess.reason ?? t("studio.einfo.removeItem")}
                        aria-label={t("studio.einfo.removeItem")}
                        onclick={() => void removeSaved(row, item)}
                      >
                        <UiIcon name="close" />
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}

              {#if row.candidates.length}
                <div class="studio-einfo-cands">
                  <span class="studio-einfo-sublabel">{t("studio.einfo.foundList")}</span>
                  {#each row.candidates as cand, i (`${cand.id ?? cand.source ?? cand.kind}-${i}`)}
                    {@const dup = isDup(row, i)}
                    <div class="studio-einfo-cand" class:is-dup={dup}>
                      <label class="studio-einfo-cand__pick">
                        <input
                          type="checkbox"
                          checked={!dup && (row.picked[i] ?? false)}
                          disabled={dup}
                          onchange={(e) => {
                            const picked = [...row.picked];
                            picked[i] = e.currentTarget.checked;
                            patchRow(row.key, { picked });
                          }}
                        />
                        <span class="studio-einfo-cand__cap">{kindLabel(cand)}</span>
                        {#if cand.source}
                          <span class="studio-einfo-chip">{sourceName(cand.source)}</span>
                        {/if}
                        {#if cand.lang && cand.lang !== i18n.locale}
                          <span class="studio-einfo-chip" title={t("studio.einfo.otherLang")}>{cand.lang.toUpperCase()}</span>
                        {/if}
                        {#if cand.kind === "trivia" && cand.title}
                          <span class="studio-einfo-chip studio-einfo-chip--accent">{t("studio.einfo.kindTrivia")}</span>
                        {/if}
                        {#if dup}
                          <em class="studio-einfo-existing">{t("studio.einfo.dupSaved")}</em>
                        {/if}
                      </label>
                      <div class="studio-einfo-cand__body">
                        {#if row.kind === "artist" && cand.imageUrl}
                          <label class="studio-einfo-photo" title={t("studio.einfo.usePhoto")}>
                            <input
                              type="checkbox"
                              checked={photoUrl === cand.imageUrl}
                              disabled={!studioAccess.canWrite}
                              onchange={(e) => {
                                photoUrl = e.currentTarget.checked ? (cand.imageUrl ?? null) : null;
                              }}
                            />
                            <img src={cand.imageUrl} alt="" loading="lazy" />
                            <span class="subtle sm">{t("studio.einfo.usePhoto")}</span>
                          </label>
                        {/if}
                        {#if row.picked[i] && !dup}
                          <textarea
                            class="rk-textarea studio-einfo-cand__text"
                            rows="4"
                            aria-label={t("studio.einfo.editText")}
                            value={row.texts[i]}
                            oninput={(e) => {
                              const texts = [...row.texts];
                              texts[i] = e.currentTarget.value;
                              patchRow(row.key, { texts });
                            }}
                          ></textarea>
                        {:else}
                          <p class="subtle sm studio-einfo-cand__preview">{preview(row.texts[i] ?? cand.text)}</p>
                        {/if}
                        {#if cand.url}
                          <a class="studio-einfo-cand__link" href={cand.url} target="_blank" rel="noreferrer noopener">
                            {t("studio.einfo.openSource")}
                          </a>
                        {/if}
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}

      <div class="studio-action-row studio-einfo-save">
        <button
          type="button"
          class="primary-btn"
          disabled={savingAll || busy || !savable || !studioAccess.canWrite}
          title={studioAccess.reason ?? undefined}
          onclick={() => void saveAll()}
        >
          {savingAll ? t("studio.einfo.saving") : t("studio.einfo.saveSelected")}
        </button>
        {#if artistImage}
          <span class="subtle sm">{t("studio.einfo.hasPhoto")}</span>
        {/if}
      </div>
    </div>
  {/if}
  {#if note}
    <p class="subtle sm studio-einfo-note" role="status">{note}</p>
  {/if}
</div>
