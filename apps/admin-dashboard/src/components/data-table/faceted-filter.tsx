'use client'

import * as React from 'react'
import { type Column, type Row } from '@tanstack/react-table'
import { Check, PlusCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

type DataTableFacetedFilterOption = {
  label: string
  value: string
  icon?: React.ComponentType<{ className?: string }>
}

type DataTableFacetedFilterProps<TData, TValue> = {
  column?: Column<TData, TValue>
  title?: string
  options: DataTableFacetedFilterOption[]
}

export function DataTableFacetedFilter<TData, TValue>({
  column,
  title,
  options,
}: DataTableFacetedFilterProps<TData, TValue>) {
  const facets = column?.getFacetedUniqueValues()

  const selectedValues = new Set(
    (column?.getFilterValue() as string[]) ?? []
  )

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant='outline' size='sm' className='h-9 border-dashed'>
          {(() => {
            const iconOpt = options.find((o) => o.icon)
            if (!iconOpt?.icon) return null
            const Icon = iconOpt.icon
            return <Icon className='size-4' />
          })()}
          {title}
          {selectedValues?.size > 0 && (
            <>
              <div className='flex items-center gap-1 px-0.5'>
                <Badge
                  variant='secondary'
                  className='rounded-sm px-1 font-normal lg:hidden'
                >
                  {selectedValues.size}
                </Badge>
                <div className='hidden gap-1 lg:flex'>
                  {selectedValues.size > 2 ? (
                    <Badge
                      variant='secondary'
                      className='rounded-sm px-1 font-normal'
                    >
                      {selectedValues.size} selected
                    </Badge>
                  ) : (
                    options
                      .filter((option) => selectedValues.has(option.value))
                      .map((option) => (
                        <Badge
                          key={option.value}
                          variant='secondary'
                          className='rounded-sm px-1 font-normal'
                        >
                          {option.label}
                        </Badge>
                      ))
                  )}
                </div>
              </div>
              <button
                type='button'
                className='ms-1 rounded-sm opacity-70 hover:opacity-100'
                onClick={(e) => {
                  e.stopPropagation()
                  column?.setFilterValue(undefined)
                }}
                aria-label={`Clear ${title} filter`}
              >
                <PlusCircle className='size-3.5 rotate-45' />
              </button>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[200px] p-0' align='start'>
        <Command>
          <CommandInput placeholder={title} />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = selectedValues.has(option.value)
                return (
                  <CommandItem
                    key={option.value}
                    onSelect={() => {
                      if (isSelected) {
                        selectedValues.delete(option.value)
                      } else {
                        selectedValues.add(option.value)
                      }
                      const filterValues = Array.from(selectedValues)
                      column?.setFilterValue(
                        filterValues.length ? filterValues : undefined
                      )
                    }}
                  >
                    <div
                      className={cn(
                        'flex size-4 items-center justify-center border rounded-[4px]',
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'opacity-50'
                      )}
                    >
                      {isSelected && <Check className='size-3.5' />}
                    </div>
                    {option.icon && (
                      <option.icon className='size-4 text-muted-foreground' />
                    )}
                    <span>{option.label}</span>
                    {facets?.get(option.value) && (
                      <span className='ms-auto flex size-4 items-center justify-center font-mono text-xs'>
                        {facets.get(option.value)}
                      </span>
                    )}
                  </CommandItem>
                )
              })}
              {selectedValues.size > 0 && (
                <>
                  <CommandSeparator />
                  <CommandItem
                    onSelect={() => column?.setFilterValue(undefined)}
                    className='justify-center text-center'
                  >
                    Clear filters
                  </CommandItem>
                </>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// Re-export Row for convenience in column definitions
export type { Row }
