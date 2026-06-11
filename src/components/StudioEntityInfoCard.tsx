import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { getEntityInfo, saveEntityInfo, searchEntityInfo } from "../lib/api";
import type {
  EntityInfoCandidate,
  EntityInfoItem,
  LibArtist,
} from "../types";
import { UiChevronRight, UiClose } from "./RekordUiIcons";

type EinfoTargetKind = "artist" | "album";

type EinfoRow = {
  /** "artist" oppure relPath album. */
  key: string;
  kind: EinfoTargetKind;
  label: string;
  /** Cartella album (segmento), null per l'artista. */
  albumDir: string | null;
  albumName: string | null;
  candidates: EntityInfoCandidate[];
  /** Selezione e testo modificabile per ciascun candidato. */
  picked: boolean[];
  texts: string[];
  open: boolean;
  /** false per le righe mostrate solo per gestire le voci già salvate. */
  searched: boolean;
};

function albumDirFromRelPath(relPath: string): string {
  return relPath.split("/").slice(1).join("/");
}

function itemPreview(item: EntityInfoItem): string {
  if (item.title) return item.title;
  return item.text.length > 70 ? `${item.text.slice(0, 70)}…` : item.text;
}

/** Chiave anti-doppione (allineata al server): testo normalizzato. */
function normText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 140);
}

/**
 * Studio → Metadati → Opzionali: cerca sul web più voci di curiosità per un
 * artista (con tutti i suoi album) o per album selezionati — nella lingua
 * dell'app — e lascia scegliere voce per voce cosa salvare (testo
 * modificabile). Le voci già salvate sono elencate ed eliminabili una a una.
 */
export function StudioEntityInfoCard({ artists }: { artists: LibArtist[] }) {
  const { t, locale, sortLocale } = useI18n();
  const [artistId, setArtistId] = useState("");
  const [scope, setScope] = useState<"artist" | "albums">("artist");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [progress, setProgress] = useState<{ cur: number; tot: number } | null>(
    null
  );
  const [rows, setRows] = useState<EinfoRow[]>([]);
  const [savedByKey, setSavedByKey] = useState<
    Record<string, EntityInfoItem[]>
  >({});

  const artist = useMemo(
    () => artists.find((a) => a.id === artistId) ?? null,
    [artists, artistId]
  );
  const artistsSorted = useMemo(
    () =>
      [...artists].sort((a, b) =>
        a.name.localeCompare(b.name, sortLocale, { numeric: true })
      ),
    [artists, sortLocale]
  );
  const albums = useMemo(() => {
    if (!artist) return [] as { relPath: string; name: string }[];
    return artist.albums
      .filter((al) => al.id !== "__loose__")
      .map((al) => ({
        relPath: al.relPath || `${artist.id}/${al.name}`,
        name: al.name,
      }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, sortLocale, { numeric: true })
      );
  }, [artist, sortLocale]);

  useEffect(() => {
    setSelected(new Set());
    setRows([]);
    setSavedByKey({});
    if (!artist) return;
    let active = true;
    const targets: { key: string; albumDir: string | null }[] = [
      { key: "artist", albumDir: null },
      ...albums.map((al) => ({
        key: al.relPath,
        albumDir: albumDirFromRelPath(al.relPath),
      })),
    ];
    void Promise.all(
      targets.map(async (tg) => {
        const bundle = await getEntityInfo(artist.id, tg.albumDir).catch(
          () => ({ items: [] as EntityInfoItem[] })
        );
        return [
          tg.key,
          bundle.items.filter((it) => it.lang === locale),
        ] as const;
      })
    ).then((pairs) => {
      if (!active) return;
      setSavedByKey(Object.fromEntries(pairs));
      // Righe subito visibili per i target con voci già salvate: si possono
      // eliminare senza dover rilanciare la ricerca.
      const labelByKey = new Map<string, { kind: EinfoTargetKind; label: string; albumDir: string | null; albumName: string | null }>([
        [
          "artist",
          {
            kind: "artist" as const,
            label: artist.name,
            albumDir: null,
            albumName: null,
          },
        ],
        ...albums.map(
          (al) =>
            [
              al.relPath,
              {
                kind: "album" as const,
                label: al.name,
                albumDir: albumDirFromRelPath(al.relPath),
                albumName: al.name,
              },
            ] as const
        ),
      ]);
      const savedRows: EinfoRow[] = pairs
        .filter(([, items]) => items.length > 0)
        .map(([key]) => ({
          key,
          ...labelByKey.get(key)!,
          candidates: [],
          picked: [],
          texts: [],
          open: false,
          searched: false,
        }));
      setRows((prev) => (prev.length ? prev : savedRows));
    });
    return () => {
      active = false;
    };
  }, [artist, albums, locale]);

  const kindLabel = (c: EntityInfoCandidate) => {
    if (c.title) return c.title;
    if (c.kind === "trivia") return t("tools.einfoKindTrivia");
    if (c.kind === "bio") return t("tools.einfoKindBio");
    return t("tools.einfoKindDesc");
  };

  const run = async () => {
    if (!artist || busy) return;
    const targets: Omit<
      EinfoRow,
      "candidates" | "picked" | "texts" | "open" | "searched"
    >[] = [];
    if (scope === "artist") {
      targets.push({
        key: "artist",
        kind: "artist",
        label: artist.name,
        albumDir: null,
        albumName: null,
      });
      for (const al of albums) {
        targets.push({
          key: al.relPath,
          kind: "album",
          label: al.name,
          albumDir: albumDirFromRelPath(al.relPath),
          albumName: al.name,
        });
      }
    } else {
      for (const al of albums) {
        if (!selected.has(al.relPath)) continue;
        targets.push({
          key: al.relPath,
          kind: "album",
          label: al.name,
          albumDir: albumDirFromRelPath(al.relPath),
          albumName: al.name,
        });
      }
    }
    if (!targets.length) return;
    setBusy(true);
    setRows([]);
    setProgress({ cur: 0, tot: targets.length });
    const acc: EinfoRow[] = [];
    for (const [i, tg] of targets.entries()) {
      const candidates = await searchEntityInfo(
        artist.name,
        tg.albumName,
        locale
      ).catch(() => [] as EntityInfoCandidate[]);
      const savedKeys = new Set(
        (savedByKey[tg.key] ?? []).map((it) => normText(it.text))
      );
      acc.push({
        ...tg,
        candidates,
        // Pre-spuntate, tranne le voci già salvate (niente doppioni).
        picked: candidates.map((c) => !savedKeys.has(normText(c.text))),
        texts: candidates.map((c) => c.text),
        open: false,
        searched: true,
      });
      setRows([...acc]);
      setProgress({ cur: i + 1, tot: targets.length });
    }
    setBusy(false);
  };

  const patchRow = (key: string, patch: Partial<EinfoRow>) => {
    setRows((prev) =>
      prev.map((row) => (row.key === key ? { ...row, ...patch } : row))
    );
  };

  const removeSavedItem = async (row: EinfoRow, item: EntityInfoItem) => {
    if (!artist) return;
    const bundle = await saveEntityInfo(artist.id, row.albumDir, {
      removeIds: [item.id],
    }).catch(() => null);
    if (!bundle) return;
    setSavedByKey((prev) => ({
      ...prev,
      [row.key]: bundle.items.filter((it) => it.lang === locale),
    }));
  };

  const saveAll = async () => {
    if (!artist || savingAll) return;
    setSavingAll(true);
    for (const row of rows) {
      const add = row.candidates
        .map((cand, i) =>
          row.picked[i] && row.texts[i]?.trim()
            ? {
                lang: locale,
                title: cand.title ?? null,
                text: row.texts[i].trim(),
              }
            : null
        )
        .filter((x): x is NonNullable<typeof x> => x !== null);
      if (!add.length) continue;
      const imageUrl =
        row.kind === "artist"
          ? (row.candidates.find((c, i) => row.picked[i] && c.thumbnail)
              ?.thumbnail ??
            row.candidates.find((c) => c.thumbnail)?.thumbnail ??
            null)
          : null;
      const bundle = await saveEntityInfo(artist.id, row.albumDir, {
        add,
        imageUrl,
      }).catch(() => null);
      if (bundle) {
        setSavedByKey((prev) => ({
          ...prev,
          [row.key]: bundle.items.filter((it) => it.lang === locale),
        }));
        patchRow(row.key, { picked: row.candidates.map(() => false) });
      }
    }
    setSavingAll(false);
  };

  const savable = rows.some((row) =>
    row.picked.some((p, i) => p && row.texts[i]?.trim())
  );

  return (
    <div className="studio-action-group studio-einfo">
      <span className="studio-action-group-label">{t("tools.einfoLabel")}</span>
      <p className="subtle sm studio-hint-line">{t("tools.einfoHint")}</p>
      <select
        className="select"
        value={artistId}
        onChange={(e) => setArtistId(e.target.value)}
        aria-label={t("tools.pickerArtist")}
      >
        <option value="">{t("tools.pickerPlaceholder")}</option>
        {artistsSorted.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <div
        className="segmented segmented--joined studio-einfo-scope"
        role="group"
        aria-label={t("tools.einfoScopeAria")}
      >
        <button
          type="button"
          className={scope === "artist" ? "is-on" : ""}
          onClick={() => setScope("artist")}
        >
          {t("tools.einfoScopeArtist")}
        </button>
        <button
          type="button"
          className={scope === "albums" ? "is-on" : ""}
          onClick={() => setScope("albums")}
        >
          {t("tools.einfoScopeAlbums")}
        </button>
      </div>
      {scope === "albums" && artist ? (
        <div className="studio-einfo-albums">
          {albums.map((al) => (
            <label key={al.relPath} className="studio-einfo-album-check">
              <input
                type="checkbox"
                checked={selected.has(al.relPath)}
                onChange={(e) => {
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(al.relPath);
                    else next.delete(al.relPath);
                    return next;
                  });
                }}
              />
              <span>
                {al.name}
                {savedByKey[al.relPath]?.length ? (
                  <em className="studio-einfo-existing">
                    {" "}
                    ·{" "}
                    {t("tools.einfoSavedCount", {
                      n: savedByKey[al.relPath].length,
                    })}
                  </em>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      ) : null}
      <div className="studio-action-row studio-einfo-run">
        <button
          type="button"
          className="primary-btn"
          disabled={
            busy || !artist || (scope === "albums" && selected.size === 0)
          }
          onClick={() => void run()}
        >
          {busy ? t("tools.einfoSearching") : t("tools.einfoSearch")}
        </button>
        {progress && busy ? (
          <span className="subtle sm">
            {progress.cur}/{progress.tot}
          </span>
        ) : null}
      </div>
      {rows.filter(
        (row) => row.searched || (savedByKey[row.key]?.length ?? 0) > 0
      ).length ? (
        <div className="studio-einfo-results">
          {rows
            .filter(
              (row) =>
                row.searched || (savedByKey[row.key]?.length ?? 0) > 0
            )
            .map((row) => {
            const saved = savedByKey[row.key] ?? [];
            const thumb =
              row.kind === "artist"
                ? (row.candidates.find((c) => c.thumbnail)?.thumbnail ?? null)
                : null;
            const pickedCount = row.picked.filter(Boolean).length;
            return (
              <div
                key={row.key}
                className={`studio-einfo-row${row.open ? " is-open" : ""}`}
              >
                <div className="studio-einfo-row__head">
                  <button
                    type="button"
                    className="studio-einfo-row__toggle"
                    onClick={() => patchRow(row.key, { open: !row.open })}
                    aria-expanded={row.open}
                  >
                    <span className="studio-einfo-row__label">
                      {row.kind === "artist"
                        ? t("tools.einfoArtistRow", { name: row.label })
                        : row.label}
                    </span>
                    <span className="studio-einfo-row__state subtle sm">
                      {!row.searched
                        ? t("tools.einfoSavedCount", { n: saved.length })
                        : row.candidates.length === 0
                          ? t("tools.einfoNoResults")
                          : [
                              t("tools.einfoFoundCount", {
                                n: row.candidates.length,
                              }),
                              pickedCount
                                ? t("tools.einfoPickedCount", {
                                    n: pickedCount,
                                  })
                                : null,
                              saved.length
                                ? t("tools.einfoSavedCount", {
                                    n: saved.length,
                                  })
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                    </span>
                    <UiChevronRight
                      className={
                        row.open
                          ? "studio-einfo-row__chev is-open"
                          : "studio-einfo-row__chev"
                      }
                      aria-hidden
                    />
                  </button>
                </div>
                {row.open ? (
                  <div className="studio-einfo-row__panel">
                    {saved.length ? (
                      <div className="studio-einfo-saved">
                        <span className="subtle sm">
                          {t("tools.einfoSavedList")}
                        </span>
                        {saved.map((item) => (
                          <div className="studio-einfo-saved__row" key={item.id}>
                            <span className="studio-einfo-saved__label">
                              {itemPreview(item)}
                            </span>
                            <button
                              type="button"
                              className="ghost-btn ghost-btn--icon-only studio-einfo-saved__rm"
                              onClick={() => void removeSavedItem(row, item)}
                              title={t("tools.einfoRemoveItem")}
                              aria-label={t("tools.einfoRemoveItem")}
                            >
                              <UiClose className="studio-einfo-saved__rm-ic" />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {row.candidates.length ? (
                      <div className="studio-einfo-row__body">
                        {thumb ? (
                          <img
                            className="studio-einfo-row__thumb"
                            src={thumb}
                            alt=""
                            aria-hidden
                          />
                        ) : null}
                        <div className="studio-einfo-cands">
                          <span className="subtle sm">
                            {t("tools.einfoFoundList")}
                          </span>
                          {row.candidates.map((cand, i) => {
                            const isDup = saved.some(
                              (it) =>
                                normText(it.text) ===
                                normText(row.texts[i] ?? cand.text)
                            );
                            return (
                            <div
                              className="studio-einfo-cand"
                              key={`${cand.kind}-${i}`}
                            >
                              <label className="studio-einfo-cand__pick">
                                <input
                                  type="checkbox"
                                  checked={!isDup && (row.picked[i] ?? false)}
                                  disabled={isDup}
                                  onChange={(e) => {
                                    const picked = [...row.picked];
                                    picked[i] = e.target.checked;
                                    patchRow(row.key, { picked });
                                  }}
                                />
                                <span className="studio-einfo-cand__cap">
                                  {kindLabel(cand)}
                                </span>
                                {cand.kind === "trivia" ? (
                                  <span className="studio-einfo-row__tag">
                                    {t("tools.einfoKindTrivia")}
                                  </span>
                                ) : null}
                                {isDup ? (
                                  <em className="studio-einfo-existing">
                                    {t("tools.einfoDupSaved")}
                                  </em>
                                ) : null}
                              </label>
                              {row.picked[i] ? (
                                <textarea
                                  className="ghost-input w-full studio-einfo-row__text"
                                  rows={4}
                                  value={row.texts[i]}
                                  onChange={(e) => {
                                    const texts = [...row.texts];
                                    texts[i] = e.target.value;
                                    patchRow(row.key, { texts });
                                  }}
                                />
                              ) : (
                                <p className="subtle sm studio-einfo-cand__preview">
                                  {row.texts[i]?.slice(0, 160)}
                                  {row.texts[i] && row.texts[i].length > 160
                                    ? "…"
                                    : ""}
                                </p>
                              )}
                            </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          <div className="studio-action-row">
            <button
              type="button"
              className="primary-btn"
              disabled={savingAll || busy || !savable}
              onClick={() => void saveAll()}
            >
              {savingAll ? "…" : t("tools.einfoSaveSelected")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
