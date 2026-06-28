'use client';

import { Loader } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FormControl } from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type SelectDropdownOption = {
  label: string;
  value: string;
  icon?: React.ElementType;
  disabled?: boolean;
};

type SelectDropdownProps = {
  value?: string;
  onValueChange: (value: string) => void;
  options: SelectDropdownOption[];
  placeholder?: string;
  disabled?: boolean;
  isPending?: boolean;
  className?: string;
};

export function SelectDropdown({
  value,
  onValueChange,
  options,
  placeholder = 'Select',
  disabled = false,
  isPending = false,
  className = '',
}: SelectDropdownProps) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <FormControl>
        <SelectTrigger className={cn(className)}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
      </FormControl>
      <SelectContent>
        {isPending ? (
          <SelectItem disabled value="loading" className="h-14">
            <div className="flex items-center justify-center gap-2">
              <Loader className="h-5 w-5 animate-spin" />
              Loading...
            </div>
          </SelectItem>
        ) : (
          options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.icon && <option.icon className="size-4" />}
              {option.label}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}
