import { StoreProvider, useStore } from "./store";
import { Topbar } from "./components/Topbar";
import { Canvas } from "./components/Canvas";
import { BackendOfflinePanel } from "./components/BackendOfflinePanel";
import { AgentFeedPanel } from "./components/AgentFeedPanel";
import { ApprovalsPanel } from "./components/ApprovalsPanel";
import { PanelHeader } from "./components/PanelHeader";

function Board() {
  const { state, status, error } = useStore();

  return (
    <div className="grid h-screen grid-rows-[48px_1fr] overflow-hidden bg-canvas text-text-primary">
      <Topbar status={status} />
      <div className="grid min-h-0 grid-cols-[1fr_340px]">
        <main className="flex min-h-0 min-w-0 flex-col border-r border-hairline">
          <PanelHeader>Lineage</PanelHeader>
          <div className="min-h-0 flex-1">
            {status === "error" ? (
              <BackendOfflinePanel message={error} />
            ) : (
              <Canvas nodes={state.graph.nodes} edges={state.graph.edges} />
            )}
          </div>
        </main>
        <aside className="grid min-h-0 grid-rows-[60%_40%]">
          <AgentFeedPanel />
          <ApprovalsPanel pending={state.pending} terms={state.terms} actions={state.actions} />
        </aside>
      </div>
    </div>
  );
}

function App() {
  return (
    <StoreProvider>
      <Board />
    </StoreProvider>
  );
}

export default App;
