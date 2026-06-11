import { useState, type ImgHTMLAttributes, type ReactNode } from "react";

/** Copertine da `/api/cover`: di default `loading="lazy"` così titoli e card restano leggibili subito. `priority` imposta caricamento urgente (player). */
export type CoverImgProps = ImgHTMLAttributes<HTMLImageElement> & {
  priority?: boolean;
  fallback?: ReactNode;
  fallbackClassName?: string;
};

const MAX_RETRIES = 2;

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
  // Caricamenti flaky (molte richieste parallele, specie client Windows):
  // ritenta con un parametro cache-bypass prima di arrendersi al fallback.
  const [retry, setRetry] = useState<{ src: string; n: number } | undefined>();
  const failed = Boolean(src) && failedSrc === src;
  const attempts = src && retry?.src === src ? retry.n : 0;
  const effectiveSrc =
    src && attempts > 0
      ? `${src}${src.includes("?") ? "&" : "?"}retry=${attempts}`
      : src;
  const loadAttr = priority
    ? "eager"
    : loading !== undefined
      ? loading
      : "lazy";
  if (failed && fallback != null) {
    return (
      <div className={fallbackClassName || className} aria-hidden={alt ? undefined : true}>
        {fallback}
      </div>
    );
  }
  return (
    <img
      alt={alt}
      {...rest}
      className={className}
      src={effectiveSrc}
      decoding={decoding}
      loading={loadAttr}
      onError={(event) => {
        if (src && attempts < MAX_RETRIES) {
          const next = attempts + 1;
          window.setTimeout(() => setRetry({ src, n: next }), 250 * next);
          return;
        }
        setFailedSrc(src);
        onError?.(event);
      }}
    />
  );
}
