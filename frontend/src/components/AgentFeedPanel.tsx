import { PanelHeader } from "./PanelHeader";

export function AgentFeedPanel() {
  return (
    <section className="flex min-h-0 flex-col border-b border-hairline">
      <PanelHeader>Agent Feed</PanelHeader>
      <div className="flex flex-1 items-center justify-center px-4 text-center">
        <p className="text-[12px] text-text-secondary">
          No agent activity yet — run a draft or ask a question
        </p>
      </div>
    </section>
  );
}
