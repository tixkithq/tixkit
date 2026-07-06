'use client';

import * as React from 'react';
import { Plus, Loader2 } from 'lucide-react';
import { adminApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from 'sonner';

export type CreateCheckInListDialogProps = {
  eventId: string;
  onCreated: () => void;
  triggerLabel?: string;
  triggerVariant?: 'default' | 'outline';
  triggerSize?: 'default' | 'sm' | 'icon';
};

export function CreateCheckInListDialog({
  eventId,
  onCreated,
  triggerLabel = 'Create Check-in List',
  triggerVariant = 'default',
  triggerSize = 'default',
}: CreateCheckInListDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const nameInputId = React.useId();

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const result = await adminApi.createCheckInList(eventId, { name: trimmed });
      if (result.ok) {
        toast.success(`Check-in list "${trimmed}" created`);
        setName('');
        setOpen(false);
        onCreated();
      } else {
        toast.error(result.error.message);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create check-in list');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant={triggerVariant}
          size={triggerSize}
          className="gap-1.5"
          aria-label={triggerLabel || 'Create Check-in List'}
        >
          <Plus className="size-4" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Check-in List</DialogTitle>
          <DialogDescription>
            Create a new check-in list for this event. All ticket types will be accepted unless you
            restrict them later.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={nameInputId}>List Name</Label>
            <Input
              id={nameInputId}
              placeholder="e.g. Main Door, VIP Entrance"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={creating}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || creating} aria-busy={creating}>
              {creating ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
