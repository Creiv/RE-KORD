import { AppConfirmProvider } from "./context/AppConfirmContext";
import { LibrarySyncActivityProvider } from "./context/LibrarySyncActivityContext";
import { PlayerProvider } from "./context/PlayerContext";
import { RhythmModeProvider } from "./context/RhythmModeContext";
import { ToolsActivityProvider } from "./context/ToolsActivityContext";
import { UserStateProvider } from "./context/UserStateContext";
import { AppShell } from "./components/AppShell/AppShell";
import { LibraryRootGate } from "./components/LibraryRootGate/LibraryRootGate";
import { PortraitLockGate } from "./components/PortraitLockGate";
import "./App.css";
import "./responsive.css";
import "./styles/portrait-lock.css";

export default function App() {
  return (
    <LibraryRootGate>
      <LibrarySyncActivityProvider>
        <UserStateProvider>
          <PortraitLockGate>
            <AppConfirmProvider>
              <PlayerProvider>
                <RhythmModeProvider>
                  <ToolsActivityProvider>
                    <AppShell />
                  </ToolsActivityProvider>
                </RhythmModeProvider>
              </PlayerProvider>
            </AppConfirmProvider>
          </PortraitLockGate>
        </UserStateProvider>
      </LibrarySyncActivityProvider>
    </LibraryRootGate>
  );
}
