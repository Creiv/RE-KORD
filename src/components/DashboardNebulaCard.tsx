import { useUserState } from "../context/UserStateContext";
import { useI18n } from "../i18n/useI18n";
import type { AppSection, LibraryIndex } from "../types";
import { SectionHeadLead } from "./SectionHeadLead";
import { UiAutoAwesome } from "./RekordUiIcons";
import { SonicNebulaMiniPreview } from "../views/SonicNebulaView/SonicNebulaView";

type DashboardNebulaCardProps = {
  index: LibraryIndex;
  onOpenSection: (section: AppSection) => void;
};

export function DashboardNebulaCard({
  index,
  onOpenSection,
}: DashboardNebulaCardProps) {
  const { t } = useI18n();
  const user = useUserState();

  const openNebula = () => {
    user.updateSettings({ libBrowse: "nebula" });
    onOpenSection("libreria");
  };

  return (
    <section className="surface-card dashboard-page__tile dashboard-page__tile--full dashboard-nebula">
      <div className="section-head section-head--page-toolbar">
        <SectionHeadLead
          eyebrow={t("nebula.dashboardEyebrow")}
          title={t("nebula.dashboardTitle")}
          icon={<UiAutoAwesome className="section-head__ic" />}
        />
      </div>
      <SonicNebulaMiniPreview index={index} onOpen={openNebula} />
    </section>
  );
}
