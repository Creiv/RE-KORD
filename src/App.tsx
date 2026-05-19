import { AppConfirmProvider } from "./context/AppConfirmContext";
import { LibrarySyncActivityProvider } from "./context/LibrarySyncActivityContext";
import { PlayerProvider } from "./context/PlayerContext";
import { ToolsActivityProvider } from "./context/ToolsActivityContext";
import { UserStateProvider } from "./context/UserStateContext";
import { AppShell } from "./components/AppShell/AppShell";
import { LibraryRootGate } from "./components/LibraryRootGate/LibraryRootGate";
import "./App.css";
import "./responsive.css";

export default function App() {
  return (
    <LibraryRootGate>
      <LibrarySyncActivityProvider>
      <UserStateProvider>
        <AppConfirmProvider>
          <PlayerProvider>
            <ToolsActivityProvider>
              <AppShell />
            </ToolsActivityProvider>
          </PlayerProvider>
        </AppConfirmProvider>
      </UserStateProvider>
      </LibrarySyncActivityProvider>
    </LibraryRootGate>
  );
}
