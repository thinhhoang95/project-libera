"use client";

import { Table } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { ToolbarMenu } from "./toolbar-menu";

export const TABLE_GRID = 8;
export const TABLE_GRID_MENU_WIDTH = TABLE_GRID * 22 + 26;

/** A grid of cells to hover or arrow through, picking a table's size. */
export function TableGridPicker({ onPick }: { onPick: (rows: number, columns: number) => void }) {
  const [size, setSize] = useState({ rows: 3, columns: 3 });
  return (
    <div className="p-1.5">
      <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${TABLE_GRID}, 20px)` }}>
        {Array.from({ length: TABLE_GRID * TABLE_GRID }, (_, index) => {
          const rows = Math.floor(index / TABLE_GRID) + 1;
          const columns = (index % TABLE_GRID) + 1;
          const active = rows <= size.rows && columns <= size.columns;
          return (
            <button
              key={index}
              type="button"
              role="menuitem"
              aria-label={`${rows} by ${columns} table`}
              data-autofocus={rows === 3 && columns === 3 ? "" : undefined}
              className={`h-5 w-5 rounded-sm border focus-visible:outline-none ${active ? "border-accent bg-accent/25" : "border-border bg-card"}`}
              onMouseEnter={() => setSize({ rows, columns })}
              onFocus={() => setSize({ rows, columns })}
              onClick={() => onPick(rows, columns)}
            />
          );
        })}
      </div>
      <p className="pt-1.5 text-center text-xs text-muted-foreground">{size.rows} × {size.columns} (first row is the header)</p>
    </div>
  );
}

/** A toolbar button that opens the table size grid. */
export function TableInsertButton({ className, disabled, title = "Insert table", onPick }: {
  className: string;
  disabled?: boolean;
  title?: string;
  onPick: (rows: number, columns: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={className}
        aria-label="Insert table"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        // Keep the editor's selection while using the toolbar.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
      >
        <Table aria-hidden className="h-4 w-4" />
      </button>
      {open ? (
        <ToolbarMenu anchorRef={buttonRef} label="Insert table" width={TABLE_GRID_MENU_WIDTH} onClose={close}>
          <TableGridPicker onPick={(rows, columns) => { close(); onPick(rows, columns); }} />
        </ToolbarMenu>
      ) : null}
    </>
  );
}
