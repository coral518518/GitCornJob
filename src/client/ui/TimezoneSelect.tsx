import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown } from "./icons";
import { bareBase, cx } from "./styles";

type Option = { value: string; label: string };

type Props = {
  value: string;
  options: Option[];
  label: string;
  onChange: (value: string) => void;
};

/**
 * 时区选项较长，触发器嵌在连体控件右半边；菜单则按整行控件展开。
 * 菜单项由触发器维护焦点，使用 aria-activedescendant 支持标准组合框键盘操作。
 */
export function TimezoneSelect({ value, options, label, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex(o => o.value === value)));
  const [dropUp, setDropUp] = useState(false);
  const [maxHeight, setMaxHeight] = useState(384);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find(o => o.value === value) ?? options[0];

  function updatePlacement() {
    const triggerRect = trigger.current?.getBoundingClientRect();
    if (!triggerRect) return;

    let top = 0;
    let bottom = window.innerHeight;
    for (let el = root.current?.parentElement; el && el !== document.body; el = el.parentElement) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        const rect = el.getBoundingClientRect();
        top = Math.max(top, rect.top);
        bottom = Math.min(bottom, rect.bottom);
      }
    }

    const spaceBelow = Math.max(0, bottom - triggerRect.bottom - 8);
    const spaceAbove = Math.max(0, triggerRect.top - top - 8);
    const desiredHeight = Math.min(384, options.length * 36 + 8);
    const shouldDropUp = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
    setDropUp(shouldDropUp);
    setMaxHeight(Math.max(48, Math.min(384, shouldDropUp ? spaceAbove : spaceBelow)));
  }

  function openMenu() {
    setActive(Math.max(0, options.findIndex(o => o.value === value)));
    updatePlacement();
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setActive(index);
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
      } else {
        setActive(index => (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
      }
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : options.length - 1);
      if (!open) {
        updatePlacement();
        setOpen(true);
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(active);
      else openMenu();
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div ref={root} className="min-w-0 flex-1">
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onClick={() => open ? setOpen(false) : openMenu()}
        onKeyDown={onKeyDown}
        className={cx(bareBase, "flex items-center gap-2 text-left")}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.value ?? value}</span>
        <ChevronDown aria-hidden className={cx("size-4 shrink-0 text-fg-subtle transition-transform", dropUp && open && "rotate-180")} />
      </button>
      {open && (
        <div
          ref={list}
          id={listId}
          role="listbox"
          aria-label={label}
          className={cx(
            "animate-in-pop absolute left-0 z-30 w-full overflow-y-auto rounded-lg border border-border bg-panel p-1 shadow-lg",
            dropUp ? "bottom-[calc(100%+0.375rem)]" : "top-[calc(100%+0.375rem)]",
          )}
          style={{ maxHeight }}
        >
          {options.map((option, index) => (
            <div
              id={`${listId}-${index}`}
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              data-index={index}
              onMouseEnter={() => setActive(index)}
              onMouseDown={event => event.preventDefault()}
              onClick={() => choose(index)}
              className={cx(
                "cursor-pointer truncate rounded-md px-2.5 py-1.5 text-sm text-fg",
                "transition-colors duration-fast",
                active === index ? "bg-panel-hover" : "",
              )}
            >
              {option.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
