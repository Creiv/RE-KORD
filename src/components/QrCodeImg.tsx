import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** QR generato in locale (niente servizi esterni: funziona offline e l'URL non esce dalla LAN). */
export function QrCodeImg({
  value,
  size = 220,
  className,
  alt = "",
}: {
  value: string;
  size?: number;
  className?: string;
  alt?: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(value, {
      width: size,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((u) => {
        if (active) setDataUrl(u);
      })
      .catch(() => {
        if (active) setDataUrl(null);
      });
    return () => {
      active = false;
    };
  }, [value, size]);

  if (!dataUrl) return null;
  return (
    <img
      src={dataUrl}
      width={size}
      height={size}
      className={className}
      alt={alt}
    />
  );
}
