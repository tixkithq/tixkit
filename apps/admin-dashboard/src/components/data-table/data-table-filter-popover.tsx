'use client';

import * as React from 'react';
import { Check, PlusCircle } from 'lucide-react';
import type {
  TableSchema,
  ColumnSpec,
  AdminTableFilterValue,
  AdminTableFacet,
} from '@tixkit/admin-table-core';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';

type DataTableFilterPopoverProps = {
  schema: TableSchema;
  column: ColumnSpec;
  value: AdminTableFilterValue | undefined;
  onChange: (value: AdminTableFilterValue | undefined) => void;
  facet?: AdminTableFacet;
};

export function DataTableFilterPopover({
  column,
  value,
  onChange,
  facet,
}: DataTableFilterPopoverProps) {
  const isActive = value !== undefined && !isEmptyValue(value);
  const selectedCount = getSelectedCount(value);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-9 border-dashed', isActive && 'border-solid bg-accent')}
          aria-label={`Filter by ${column.label}`}
        >
          <PlusCircle className="size-4" />
          {column.label}
          {selectedCount > 0 && (
            <>
              <Badge variant="secondary" className="rounded-sm px-1 font-normal lg:hidden">
                {selectedCount}
              </Badge>
              <div className="hidden gap-1 lg:flex">
                {selectedCount > 2 ? (
                  <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                    {selectedCount} selected
                  </Badge>
                ) : (
                  <SelectedLabels value={value} />
                )}
              </div>
              <button
                type="button"
                className="ms-1 rounded-sm opacity-70 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(undefined);
                }}
                aria-label={`Clear ${column.label} filter`}
              >
                <PlusCircle className="size-3.5 rotate-45" />
              </button>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-0" align="start">
        {column.filterType === 'select' && (
          <SelectFilterContent
            column={column}
            value={value}
            onChange={onChange}
            facet={facet}
          />
        )}
        {column.filterType === 'boolean' && (
          <BooleanFilterContent column={column} value={value} onChange={onChange} facet={facet} />
        )}
        {column.filterType === 'date_range' && (
          <DateRangeFilterContent column={column} value={value} onChange={onChange} />
        )}
        {column.filterType === 'number_range' && (
          <NumberRangeFilterContent column={column} value={value} onChange={onChange} />
        )}
      </PopoverContent>
    </Popover>
  );
}

function SelectFilterContent({
  column,
  value,
  onChange,
  facet,
}: {
  column: ColumnSpec;
  value: AdminTableFilterValue | undefined;
  onChange: (value: AdminTableFilterValue | undefined) => void;
  facet?: AdminTableFacet;
}) {
  const options = column.options ?? [];
  const selectedValues = new Set(
    value?.type === 'select' ? value.values : [],
  );

  const facetCounts = React.useMemo(() => {
    const map = new Map<string, number>();
    if (facet?.rows) {
      for (const row of facet.rows) {
        map.set(String(row.value), row.total);
      }
    }
    return map;
  }, [facet]);

  return (
    <Command>
      <CommandInput placeholder={column.label} />
      <CommandList>
        <CommandEmpty>No options found.</CommandEmpty>
        <CommandGroup>
          {options.map((option) => {
            const isSelected = selectedValues.has(option);
            const count = facetCounts.get(option);
            return (
              <CommandItem
                key={option}
                onSelect={() => {
                  if (isSelected) {
                    selectedValues.delete(option);
                  } else {
                    selectedValues.add(option);
                  }
                  const values = Array.from(selectedValues);
                  onChange(values.length > 0 ? { type: 'select', values } : undefined);
                }}
              >
                <div
                  className={cn(
                    'flex size-4 items-center justify-center rounded-[4px] border',
                    isSelected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'opacity-50',
                  )}
                >
                  {isSelected && <Check className="size-3.5" />}
                </div>
                <span className="capitalize">{option.replace(/_/g, ' ')}</span>
                {count !== undefined && (
                  <span className="ms-auto flex size-4 items-center justify-center font-mono text-xs">
                    {count}
                  </span>
                )}
              </CommandItem>
            );
          })}
          {selectedValues.size > 0 && (
            <>
              <CommandSeparator />
              <CommandItem
                onSelect={() => onChange(undefined)}
                className="justify-center text-center"
              >
                Clear filter
              </CommandItem>
            </>
          )}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function BooleanFilterContent({
  column,
  value,
  onChange,
  facet,
}: {
  column: ColumnSpec;
  value: AdminTableFilterValue | undefined;
  onChange: (value: AdminTableFilterValue | undefined) => void;
  facet?: AdminTableFacet;
}) {
  const currentValue = value?.type === 'boolean' ? value.value : undefined;
  const trueCount = facet?.rows?.find((r) => r.value === true)?.total;
  const falseCount = facet?.rows?.find((r) => r.value === false)?.total;

  return (
    <div className="p-3">
      <p className="mb-2 text-sm font-medium">{column.label}</p>
      <div className="space-y-1">
        <BooleanOption
          label="Yes"
          count={trueCount}
          isSelected={currentValue === true}
          onSelect={() => onChange(currentValue === true ? undefined : { type: 'boolean', value: true })}
        />
        <BooleanOption
          label="No"
          count={falseCount}
          isSelected={currentValue === false}
          onSelect={() => onChange(currentValue === false ? undefined : { type: 'boolean', value: false })}
        />
      </div>
      {currentValue !== undefined && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full"
          onClick={() => onChange(undefined)}
        >
          Clear filter
        </Button>
      )}
    </div>
  );
}

function BooleanOption({
  label,
  count,
  isSelected,
  onSelect,
}: {
  label: string;
  count?: number;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent',
        isSelected && 'bg-accent',
      )}
    >
      <div
        className={cn(
          'flex size-4 items-center justify-center rounded-[4px] border',
          isSelected ? 'border-primary bg-primary text-primary-foreground' : 'opacity-50',
        )}
      >
        {isSelected && <Check className="size-3.5" />}
      </div>
      <span>{label}</span>
      {count !== undefined && (
        <span className="ms-auto font-mono text-xs text-muted-foreground">{count}</span>
      )}
    </button>
  );
}

function DateRangeFilterContent({
  column,
  value,
  onChange,
}: {
  column: ColumnSpec;
  value: AdminTableFilterValue | undefined;
  onChange: (value: AdminTableFilterValue | undefined) => void;
}) {
  const from = value?.type === 'date_range' ? value.from ?? '' : '';
  const to = value?.type === 'date_range' ? value.to ?? '' : '';

  const handleFromChange = (newFrom: string) => {
    const hasFrom = newFrom.trim().length > 0;
    const hasTo = to.trim().length > 0;
    if (!hasFrom && !hasTo) {
      onChange(undefined);
    } else {
      onChange({ type: 'date_range', from: hasFrom ? newFrom : undefined, to: hasTo ? to : undefined });
    }
  };

  const handleToChange = (newTo: string) => {
    const hasFrom = from.trim().length > 0;
    const hasTo = newTo.trim().length > 0;
    if (!hasFrom && !hasTo) {
      onChange(undefined);
    } else {
      onChange({ type: 'date_range', from: hasFrom ? from : undefined, to: hasTo ? newTo : undefined });
    }
  };

  return (
    <div className="p-3">
      <p className="mb-2 text-sm font-medium">{column.label}</p>
      <div className="space-y-2">
        <div>
          <Label htmlFor={`${column.id}-from`} className="text-xs text-muted-foreground">
            From
          </Label>
          <Input
            id={`${column.id}-from`}
            type="date"
            value={from}
            onChange={(e) => handleFromChange(e.target.value)}
            className="h-8"
          />
        </div>
        <div>
          <Label htmlFor={`${column.id}-to`} className="text-xs text-muted-foreground">
            To
          </Label>
          <Input
            id={`${column.id}-to`}
            type="date"
            value={to}
            onChange={(e) => handleToChange(e.target.value)}
            className="h-8"
          />
        </div>
      </div>
      {(from || to) && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full"
          onClick={() => onChange(undefined)}
        >
          Clear filter
        </Button>
      )}
    </div>
  );
}

function NumberRangeFilterContent({
  column,
  value,
  onChange,
}: {
  column: ColumnSpec;
  value: AdminTableFilterValue | undefined;
  onChange: (value: AdminTableFilterValue | undefined) => void;
}) {
  const min = value?.type === 'number_range' ? (value.min?.toString() ?? '') : '';
  const max = value?.type === 'number_range' ? (value.max?.toString() ?? '') : '';

  const handleMinChange = (newMin: string) => {
    const minNum = newMin.trim() ? Number(newMin) : undefined;
    const maxNum = max.trim() ? Number(max) : undefined;
    if (minNum === undefined && maxNum === undefined) {
      onChange(undefined);
    } else {
      onChange({ type: 'number_range', min: minNum, max: maxNum });
    }
  };

  const handleMaxChange = (newMax: string) => {
    const minNum = min.trim() ? Number(min) : undefined;
    const maxNum = newMax.trim() ? Number(newMax) : undefined;
    if (minNum === undefined && maxNum === undefined) {
      onChange(undefined);
    } else {
      onChange({ type: 'number_range', min: minNum, max: maxNum });
    }
  };

  return (
    <div className="p-3">
      <p className="mb-2 text-sm font-medium">{column.label}</p>
      <div className="space-y-2">
        <div>
          <Label htmlFor={`${column.id}-min`} className="text-xs text-muted-foreground">
            Min
          </Label>
          <Input
            id={`${column.id}-min`}
            type="number"
            value={min}
            onChange={(e) => handleMinChange(e.target.value)}
            className="h-8"
          />
        </div>
        <div>
          <Label htmlFor={`${column.id}-max`} className="text-xs text-muted-foreground">
            Max
          </Label>
          <Input
            id={`${column.id}-max`}
            type="number"
            value={max}
            onChange={(e) => handleMaxChange(e.target.value)}
            className="h-8"
          />
        </div>
      </div>
      {(min || max) && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full"
          onClick={() => onChange(undefined)}
        >
          Clear filter
        </Button>
      )}
    </div>
  );
}

function SelectedLabels({
  value,
}: {
  value: AdminTableFilterValue | undefined;
}) {
  if (value?.type === 'select') {
    return (
      <>
        {value.values.slice(0, 2).map((v) => (
          <Badge key={v} variant="secondary" className="rounded-sm px-1 font-normal">
            {v.replace(/_/g, ' ')}
          </Badge>
        ))}
      </>
    );
  }
  if (value?.type === 'boolean') {
    return (
      <Badge variant="secondary" className="rounded-sm px-1 font-normal">
        {value.value ? 'Yes' : 'No'}
      </Badge>
    );
  }
  return null;
}

function isEmptyValue(value: AdminTableFilterValue): boolean {
  switch (value.type) {
    case 'text':
      return value.value.trim().length === 0;
    case 'select':
      return value.values.length === 0;
    case 'boolean':
      return false;
    case 'date_range':
      return !value.from && !value.to;
    case 'number_range':
      return value.min === undefined && value.max === undefined;
  }
}

function getSelectedCount(value: AdminTableFilterValue | undefined): number {
  if (!value) return 0;
  if (value.type === 'select') return value.values.length;
  if (value.type === 'boolean') return 1;
  if (value.type === 'date_range') return (value.from ? 1 : 0) + (value.to ? 1 : 0);
  if (value.type === 'number_range') return (value.min !== undefined ? 1 : 0) + (value.max !== undefined ? 1 : 0);
  if (value.type === 'text') return value.value.trim() ? 1 : 0;
  return 0;
}
