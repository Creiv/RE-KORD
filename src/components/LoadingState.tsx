import { useI18n } from "../i18n/useI18n";

type Props = {
  title?: string;
  message?: string;
};

export function LoadingState({ title, message }: Props) {
  const { t } = useI18n();
  return (
    <div className="rekord-state rekord-state--loading" role="status" aria-live="polite">
      <div className="rekord-state__spinner" aria-hidden />
      <p className="rekord-state__title">{title ?? t("state.loading")}</p>
      {message ? <p className="rekord-state__message">{message}</p> : null}
    </div>
  );
}
