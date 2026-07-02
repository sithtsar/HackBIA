type PanelHeaderProps = {
  children: string;
};

export function PanelHeader({ children }: PanelHeaderProps) {
  return (
    <h2 className="shrink-0 border-b border-hairline px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
      {children}
    </h2>
  );
}
