'use client'

import { format } from 'date-fns'
import { Calendar as CalendarIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

type DatePickerProps = {
  value?: Date
  onChange: (value?: Date) => void
  placeholder?: string
  disabled?: boolean
}

export function DatePicker({
  value,
  onChange,
  placeholder = 'Pick a date',
  disabled = false,
}: DatePickerProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          disabled={disabled}
          data-empty={!value}
          className='w-60 justify-start text-start font-normal data-[empty=true]:text-muted-foreground'
        >
          {value ? format(value, 'MMM d, yyyy') : <span>{placeholder}</span>}
          <CalendarIcon className='ms-auto h-4 w-4 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-auto p-0'>
        <Calendar
          mode='single'
          captionLayout='dropdown'
          selected={value}
          onSelect={(date) => onChange(date ?? undefined)}
          disabled={disabled}
        />
      </PopoverContent>
    </Popover>
  )
}
