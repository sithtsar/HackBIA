import type { ReactNode } from "react";

type PanelHeaderProps = {
  children: string;
  /** Optional right-aligned control (e.g. the Approvals "Approve all" button). */
  action?: ReactNode;
};

export function PanelHeader({ children, action }: PanelHeaderProps) {
  return (
    <h2 className="flex shrink-0 items-center justify-between border-b border-hairline px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
      {children}
      {action}
    </h2>
  );
}
