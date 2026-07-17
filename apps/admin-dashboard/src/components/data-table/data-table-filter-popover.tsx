'use client';

/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Searchable virtualized multi-selects require the ARIA listbox pattern; native select/datalist cannot preserve the contract. */

import * as React from 'react';
import { Check, PlusCircle, Search } from 'lucide-react';
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

type DataTableFilterPopoverProps = {
  schema: TableSchema;
  column: ColumnSpec;
  value: AdminTableFilterValue | undefined;
  onChange: (value: AdminTableFilterValue | undefined) => void;
  facet?: AdminTableFacet;
};

const SELECT_OPTION_ROW_HEIGHT = 34;
const SELECT_OPTION_MAX_VISIBLE_ROWS = 8;
const SELECT_OPTION_OVERSCAN = 3;

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
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-0" align="start">
        {column.filterType === 'select' && (
          <SelectFilterContent column={column} value={value} onChange={onChange} facet={facet} />
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
  const options = React.useMemo(() => column.options ?? [], [column.options]);
  const [searchValue, setSearchValue] = React.useState('');
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const listboxId = React.useId();
  const selectedValues = new Set(value?.type === 'select' ? value.values : []);

  const facetCounts = React.useMemo(() => {
    const map = new Map<string, number>();
    if (facet?.rows) {
      for (const row of facet.rows) {
        map.set(String(row.value), row.total);
      }
    }
    return map;
  }, [facet]);

  const filteredOptions = React.useMemo(() => {
    const normalizedSearch = searchValue.trim().toLowerCase();
    if (!normalizedSearch) return options;
    return options.filter((option) =>
      formatOptionLabel(option).toLowerCase().includes(normalizedSearch),
    );
  }, [options, searchValue]);

  React.useEffect(() => {
    setScrollTop(0);
    setActiveIndex(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [searchValue]);

  const viewportHeight =
    Math.min(filteredOptions.length, SELECT_OPTION_MAX_VISIBLE_ROWS) * SELECT_OPTION_ROW_HEIGHT;
  const totalHeight = filteredOptions.length * SELECT_OPTION_ROW_HEIGHT;
  const startIndex = Math.max(
    0,
    Math.floor(scrollTop / SELECT_OPTION_ROW_HEIGHT) - SELECT_OPTION_OVERSCAN,
  );
  const visibleCount =
    Math.ceil(Math.max(viewportHeight, SELECT_OPTION_ROW_HEIGHT) / SELECT_OPTION_ROW_HEIGHT) +
    SELECT_OPTION_OVERSCAN * 2;
  const endIndex = Math.min(filteredOptions.length, startIndex + visibleCount);
  const visibleOptions = filteredOptions.slice(startIndex, endIndex);
  const topOffset = startIndex * SELECT_OPTION_ROW_HEIGHT;

  const activateOption = (nextIndex: number) => {
    if (filteredOptions.length === 0) return;
    const index = Math.max(0, Math.min(nextIndex, filteredOptions.length - 1));
    setActiveIndex(index);
    const viewport = scrollRef.current;
    if (!viewport) return;
    const optionTop = index * SELECT_OPTION_ROW_HEIGHT;
    const optionBottom = optionTop + SELECT_OPTION_ROW_HEIGHT;
    let nextScrollTop = viewport.scrollTop;
    if (optionTop < viewport.scrollTop) nextScrollTop = optionTop;
    else if (optionBottom > viewport.scrollTop + viewportHeight) {
      nextScrollTop = optionBottom - viewportHeight;
    }
    if (nextScrollTop !== viewport.scrollTop) {
      viewport.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
    }
  };

  const handleListboxKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowDown') nextIndex = activeIndex + 1;
    else if (event.key === 'ArrowUp') nextIndex = activeIndex - 1;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = filteredOptions.length - 1;
    else if (event.key === 'PageDown') nextIndex = activeIndex + SELECT_OPTION_MAX_VISIBLE_ROWS;
    else if (event.key === 'PageUp') nextIndex = activeIndex - SELECT_OPTION_MAX_VISIBLE_ROWS;
    else if (event.key === 'Enter' || event.key === ' ') {
      const option = filteredOptions[activeIndex];
      if (option !== undefined) toggleOption(option);
      event.preventDefault();
      return;
    } else return;
    event.preventDefault();
    activateOption(nextIndex);
  };

  const handleListboxScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const nextScrollTop = event.currentTarget.scrollTop;
    setScrollTop(nextScrollTop);
    const firstVisibleIndex = Math.floor(nextScrollTop / SELECT_OPTION_ROW_HEIGHT);
    const lastVisibleIndex = Math.min(
      filteredOptions.length - 1,
      firstVisibleIndex + SELECT_OPTION_MAX_VISIBLE_ROWS - 1,
    );
    if (activeIndex < firstVisibleIndex) setActiveIndex(firstVisibleIndex);
    else if (activeIndex > lastVisibleIndex) setActiveIndex(lastVisibleIndex);
  };

  const toggleOption = (option: string) => {
    const nextSelectedValues = new Set(selectedValues);
    if (nextSelectedValues.has(option)) {
      nextSelectedValues.delete(option);
    } else {
      nextSelectedValues.add(option);
    }
    const values = Array.from(nextSelectedValues);
    onChange(values.length > 0 ? { type: 'select', values } : undefined);
  };

  return (
    <div className="overflow-hidden rounded-md bg-popover text-popover-foreground">
      <div className="flex h-9 items-center gap-2 border-b px-3">
        <Search className="size-4 shrink-0 opacity-50" />
        <Input
          value={searchValue}
          onChange={(event) => setSearchValue(event.target.value)}
          placeholder={column.label}
          aria-label={`Search ${column.label} options`}
          className="h-8 border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0"
        />
      </div>
      {filteredOptions.length === 0 ? (
        <div className="py-6 text-center text-sm">No options found.</div>
      ) : (
        <>
          <div
            ref={scrollRef}
            id={listboxId}
            role="listbox"
            aria-label={`${column.label} options`}
            aria-multiselectable="true"
            aria-activedescendant={`${listboxId}_option_${activeIndex}`}
            tabIndex={0}
            className="overflow-x-hidden overflow-y-auto p-1"
            style={{ height: viewportHeight }}
            onScroll={handleListboxScroll}
            onKeyDown={handleListboxKeyDown}
            onFocus={() => activateOption(activeIndex)}
          >
            <div className="relative" style={{ height: totalHeight }}>
              <div
                className="absolute inset-x-0 top-0"
                style={{ transform: `translateY(${topOffset}px)` }}
              >
                {visibleOptions.map((option, visibleIndex) => {
                  const isSelected = selectedValues.has(option);
                  const count = facetCounts.get(option);
                  const optionIndex = startIndex + visibleIndex;
                  return (
                    <React.Fragment key={option}>
                      <button
                        id={`${listboxId}_option_${optionIndex}`}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        className={cn(
                          'flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground',
                          optionIndex === activeIndex && 'bg-accent text-accent-foreground',
                        )}
                        style={{ height: SELECT_OPTION_ROW_HEIGHT }}
                        aria-selected={isSelected}
                        data-active={optionIndex === activeIndex ? '' : undefined}
                        onClick={() => {
                          setActiveIndex(optionIndex);
                          toggleOption(option);
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
                        <span className="truncate capitalize">{formatOptionLabel(option)}</span>
                        {count !== undefined && (
                          <span className="ms-auto flex size-4 shrink-0 items-center justify-center font-mono text-xs">
                            {count}
                          </span>
                        )}
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}
      {selectedValues.size > 0 && (
        <>
          <div className="h-px bg-border" />
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="flex w-full items-center justify-center px-2 py-1.5 text-center text-sm hover:bg-accent"
          >
            Clear filter
          </button>
        </>
      )}
    </div>
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
          onSelect={() =>
            onChange(currentValue === true ? undefined : { type: 'boolean', value: true })
          }
        />
        <BooleanOption
          label="No"
          count={falseCount}
          isSelected={currentValue === false}
          onSelect={() =>
            onChange(currentValue === false ? undefined : { type: 'boolean', value: false })
          }
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
      aria-pressed={isSelected}
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
  const from = value?.type === 'date_range' ? (value.from ?? '') : '';
  const to = value?.type === 'date_range' ? (value.to ?? '') : '';

  const handleFromChange = (newFrom: string) => {
    const hasFrom = newFrom.trim().length > 0;
    const hasTo = to.trim().length > 0;
    if (!hasFrom && !hasTo) {
      onChange(undefined);
    } else {
      onChange({
        type: 'date_range',
        from: hasFrom ? newFrom : undefined,
        to: hasTo ? to : undefined,
      });
    }
  };

  const handleToChange = (newTo: string) => {
    const hasFrom = from.trim().length > 0;
    const hasTo = newTo.trim().length > 0;
    if (!hasFrom && !hasTo) {
      onChange(undefined);
    } else {
      onChange({
        type: 'date_range',
        from: hasFrom ? from : undefined,
        to: hasTo ? newTo : undefined,
      });
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

function SelectedLabels({ value }: { value: AdminTableFilterValue | undefined }) {
  if (value?.type === 'select') {
    return (
      <>
        {value.values.slice(0, 2).map((v) => (
          <Badge key={v} variant="secondary" className="rounded-sm px-1 font-normal">
            {formatOptionLabel(v)}
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
  if (value.type === 'number_range')
    return (value.min !== undefined ? 1 : 0) + (value.max !== undefined ? 1 : 0);
  if (value.type === 'text') return value.value.trim() ? 1 : 0;
  return 0;
}

function formatOptionLabel(value: string): string {
  return value.replace(/_/g, ' ');
}
