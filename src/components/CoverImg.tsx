import { useState, type ImgHTMLAttributes, type ReactNode } from "react";

/** Copertine da `/api/cover`: di default `loading="lazy"` così titoli e card restano leggibili subito. `priority` imposta caricamento urgente (player). */
export type CoverImgProps = ImgHTMLAttributes<HTMLImageElement> & {
  priority?: boolean;
  fallback?: ReactNode;
  fallbackClassName?: string;
};

const MAX_RETRIES = 2;

/** Cover già fallite in sessione → fallback istantaneo al prossimo mount,
 *  senza rifare la richiesta. Chiave = src com'è (versionata): una cover
 *  aggiunta dopo cambia version/URL e bypassa la cache negativa. */
const knownMissing = new Set<string>();

/** Retry condivisi per src (rete flaky, molte richieste parallele):
 *  girano in background mentre l'utente vede già il fallback. */
const pendingRetries = new Map<string, Promise<string | null>>();

function retryInBackground(src: string): Promise<string | null> {
  let p = pendingRetries.get(src);
  if (!p) {
    p = (async () => {
      for (let n = 1; n <= MAX_RETRIES; n++) {
        await new Promise((r) => window.setTimeout(r, 250 * n));
        const url = `${src}${src.includes("?") ? "&" : "?"}retry=${n}`;
        const ok = await new Promise<boolean>((resolve) => {
          const probe = new Image();
          probe.onload = () => resolve(true);
          probe.onerror = () => resolve(false);
          probe.src = url;
        });
        if (ok) return url;
      }
      return null;
    })();
    pendingRetries.set(src, p);
    p.finally(() => pendingRetries.delete(src));
  }
  return p;
}

export function CoverImg({
  priority = false,
  fallback,
  fallbackClassName,
  loading,
  decoding = "async",
  alt = "",
  onError,
  src,
  className,
  ...rest
}: CoverImgProps) {
  const [failedSrc, setFailedSrc] = useState<string | undefined>();
  // URL (con parametro retry) andato a buon fine dopo un primo errore flaky.
  const [recovered, setRecovered] = useState<
    { src: string; url: string } | undefined
  >();

  const recoveredUrl = src && recovered?.src === src ? recovered.url : undefined;
  // Niente src, già fallita ora o in una mount precedente → iniziali subito.
  const missing =
    !src || (!recoveredUrl && (failedSrc === src || knownMissing.has(src)));

  if (missing && fallback != null) {
    return (
      <div
        className={fallbackClassName || className}
        aria-hidden={alt ? undefined : true}
      >
        {fallback}
      </div>
    );
  }

  const loadAttr = priority
    ? "eager"
    : loading !== undefined
      ? loading
      : "lazy";

  return (
    <img
      alt={alt}
      {...rest}
      className={className}
      src={recoveredUrl ?? src}
      decoding={decoding}
      loading={loadAttr}
      onError={(event) => {
        if (!src || recoveredUrl) return;
        // Fallback immediato: un 404 è una risposta, non un'attesa. I retry
        // anti-flaky proseguono in background e, se la cover esiste davvero,
        // l'immagine ricompare appena caricata (ormai in cache HTTP).
        knownMissing.add(src);
        setFailedSrc(src);
        retryInBackground(src).then((url) => {
          if (url) {
            knownMissing.delete(src);
            setRecovered({ src, url });
            setFailedSrc((cur) => (cur === src ? undefined : cur));
          }
        });
        onError?.(event);
      }}
    />
  );
}
