import { Dialog as RDialog, DropdownMenu, Switch as RSwitch, Tooltip as RTooltip } from "radix-ui";
import { X } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "../lib/format";

export function Tip({ content, children, side = "bottom", kbd }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right"; kbd?: string }) {
  if (!content) return <>{children}</>;
  return (
    <RTooltip.Root delayDuration={350}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-[100] max-w-xs rounded-md bg-stone-900 px-2.5 py-1.5 text-[12px] leading-snug text-stone-50 shadow-lg dark:bg-stone-100 dark:text-stone-900"
        >
          <span className="flex items-center gap-2">
            <span>{content}</span>
            {kbd && <Kbd className="border-white/20 bg-white/10 text-stone-200 dark:border-black/10 dark:bg-black/5 dark:text-stone-600">{kbd}</Kbd>}
          </span>
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cx("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line bg-surface-2 px-1 font-mono text-[10.5px] font-medium text-ink-2", className)}>
      {children}
    </kbd>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "outline" | "danger";
  size?: "sm" | "md";
};

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = "default", size = "md", className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      className={cx(
        "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-45",
        size === "sm" ? "h-7 px-2.5 text-[12.5px]" : "h-8 px-3 text-[13px]",
        variant === "default" && "border border-line bg-surface text-ink shadow-[0_1px_0_rgb(0_0_0/0.03)] hover:bg-surface-3",
        variant === "primary" && "bg-ink text-surface hover:opacity-90",
        variant === "ghost" && "text-ink-2 hover:bg-surface-3 hover:text-ink",
        variant === "outline" && "border border-line text-ink-2 hover:border-line-strong hover:text-ink",
        variant === "danger" && "border border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10",
        className,
      )}
      {...rest}
    />
  );
});

export const IconButton = forwardRef<HTMLButtonElement, BtnProps & { label: string; kbd?: string; active?: boolean; tipSide?: "top" | "bottom" | "left" | "right" }>(
  function IconButton({ label, kbd, active, className, tipSide, children, ...rest }, ref) {
    return (
      <Tip content={label} kbd={kbd} side={tipSide}>
        <button
          ref={ref}
          aria-label={label}
          aria-pressed={active}
          className={cx(
            "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:pointer-events-none disabled:opacity-40",
            active && "bg-surface-3 text-ink",
            className,
          )}
          {...rest}
        >
          {children}
        </button>
      </Tip>
    );
  },
);

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; id: string }) {
  return (
    <label htmlFor={id} className="inline-flex cursor-pointer select-none items-center gap-2 text-[12.5px] text-ink-2">
      <RSwitch.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        className="relative h-[18px] w-8 shrink-0 rounded-full bg-line-strong transition-colors data-[state=checked]:bg-accent"
      >
        <RSwitch.Thumb className="block h-3.5 w-3.5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[15px]" />
      </RSwitch.Root>
      {label}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; title?: string }[];
  className?: string;
}) {
  return (
    <div className={cx("inline-flex rounded-lg bg-surface-3 p-0.5", className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          title={o.title}
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "flex-1 whitespace-nowrap rounded-md px-2 py-1 text-[12px] font-medium transition-colors",
            value === o.value ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink-2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Menu({ trigger, children, align = "end" }: { trigger: ReactNode; children: ReactNode; align?: "start" | "end" }) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={6}
          className="z-[90] min-w-[220px] rounded-lg border border-line bg-surface p-1 text-[13px] shadow-xl"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({ children, onSelect, icon, hint, disabled }: { children: ReactNode; onSelect: () => void; icon?: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className="flex cursor-default select-none items-center gap-2.5 rounded-md px-2 py-1.5 text-ink-2 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-3 data-[highlighted]:text-ink"
    >
      <span className="flex h-4 w-4 items-center justify-center text-ink-3">{icon}</span>
      <span className="flex-1">{children}</span>
      {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
    </DropdownMenu.Item>
  );
}

export const MenuSeparator = () => <DropdownMenu.Separator className="my-1 h-px bg-line" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{children}</DropdownMenu.Label>
);

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = "max-w-2xl",
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-[95] bg-black/30 backdrop-blur-[2px] dark:bg-black/60" />
        <RDialog.Content
          className={cx(
            "fixed left-1/2 top-[8vh] z-[96] flex max-h-[84vh] w-[calc(100vw-32px)] -translate-x-1/2 flex-col rounded-xl border border-line bg-surface shadow-2xl outline-none",
            width,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <RDialog.Title className="text-[15px] font-semibold text-ink">{title}</RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-0.5 text-[12.5px] text-ink-3">{description}</RDialog.Description>
              ) : (
                <RDialog.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</RDialog.Description>
              )}
            </div>
            <RDialog.Close asChild>
              <IconButton label="Close" className="-mr-2 -mt-1">
                <X size={16} />
              </IconButton>
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg className={cx("animate-spin", className)} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-1 pb-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{children}</h3>
      {right}
    </div>
  );
}
