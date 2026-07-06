'use client';

import { type Table } from '@tanstack/react-table';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type DataTableV2ViewOptionsProps<TData> = {
  table: Table<TData>;
};

export function DataTableV2ViewOptions<TData>({ table }: DataTableV2ViewOptionsProps<TData>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9">
          <SlidersHorizontal className="size-4" />
          View
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[180px]">
        <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {table
          .getAllColumns()
          .filter((column) => typeof column.accessorFn !== 'undefined' && column.getCanHide())
          .map((column) => (
            <div key={column.id} className="flex items-center gap-2 px-2 py-1.5">
              <Checkbox
                checked={column.getIsVisible()}
                onCheckedChange={(value) => column.toggleVisibility(!!value)}
                id={`v2-col-${column.id}`}
              />
              <label htmlFor={`v2-col-${column.id}`} className="flex-1 cursor-pointer text-sm">
                {column.columnDef.meta?.title ?? column.id}
              </label>
            </div>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
