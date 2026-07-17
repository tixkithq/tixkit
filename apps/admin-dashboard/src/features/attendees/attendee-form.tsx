'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { type AdminAttendeeListItem, type UpdateAttendeeInput, adminApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';

const attendeeSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().optional(),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  phone: z.string().optional(),
});

type AttendeeFormValues = z.infer<typeof attendeeSchema>;

type AttendeeFormDialogProps = {
  attendee: AdminAttendeeListItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
};

export function AttendeeFormDialog({
  attendee,
  open,
  onOpenChange,
  onSuccess,
}: AttendeeFormDialogProps) {
  const [submitting, setSubmitting] = React.useState(false);

  const form = useForm<AttendeeFormValues>({
    resolver: zodResolver(attendeeSchema),
    defaultValues: {
      firstName: attendee?.firstName ?? '',
      lastName: attendee?.lastName ?? '',
      email: attendee?.email ?? '',
      phone: attendee?.phone ?? '',
    },
  });

  React.useEffect(() => {
    if (open && attendee) {
      form.reset({
        firstName: attendee.firstName ?? '',
        lastName: attendee.lastName ?? '',
        email: attendee.email ?? '',
        phone: attendee.phone ?? '',
      });
    }
  }, [open, attendee, form]);

  const onSubmit = async (values: AttendeeFormValues) => {
    if (!attendee) return;
    setSubmitting(true);
    const input: UpdateAttendeeInput = {
      firstName: values.firstName,
      lastName: values.lastName || null,
      email: values.email || undefined,
      phone: values.phone || null,
    };
    const result = await adminApi.updateAttendee(attendee.id, input);
    setSubmitting(false);
    if (result.ok) {
      toast.success('Attendee updated');
      onOpenChange(false);
      onSuccess?.();
    } else {
      toast.error(result.error.message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Attendee</DialogTitle>
          <DialogDescription>Update attendee details for {attendee?.name}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="firstName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>First name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="lastName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Last name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input type="email" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone</FormLabel>
                  <FormControl>
                    <Input type="tel" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Saving...' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
