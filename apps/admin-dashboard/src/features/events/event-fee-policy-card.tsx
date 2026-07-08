'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { z } from 'zod';
import {
  type AdminFeePolicy,
  type AdminTicketType,
  type UpdateEventFeePolicyInput,
  adminApi,
} from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { formatCurrency } from '@/lib/format';
import { toast } from 'sonner';

export const feePolicyFormSchema = z
  .object({
    passFeesToBuyer: z.boolean(),
    rules: z
      .array(
        z
          .object({
            id: z.string().optional(),
            name: z.string().trim().min(1, 'Name is required').max(80),
            type: z.enum(['percentage', 'fixed']),
            value: z.number().int().min(0),
            appliedTo: z.enum(['per_ticket', 'per_order']),
          })
          .superRefine((rule, ctx) => {
            if (rule.type === 'percentage' && rule.value > 10_000) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['value'],
                message: 'Percentage fees cannot exceed 100%',
              });
            }
            if (rule.type === 'fixed' && rule.value > 100_000_000) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['value'],
                message: 'Fixed fees cannot exceed 1,000,000.00',
              });
            }
          }),
      )
      .max(5, 'Use five or fewer fee rules'),
  })
  .strict();

export type FeePolicyFormValues = z.infer<typeof feePolicyFormSchema>;
const FEE_POLICY_AUTOSAVE_DELAY_MS = 300;

// Stripe US standard processing fee (2.9% + $0.30). Preview/demonstration only;
// this is not applied to settlement. Kept as constants so it can be made
// configurable later.
export const DEFAULT_PLATFORM_FEE_BPS = 290;
export const DEFAULT_PLATFORM_FEE_FIXED_CENTS = 30;

export function computePlatformFeeCents(priceCents: number): number {
  if (priceCents <= 0) return 0;
  return (
    Math.round((priceCents * DEFAULT_PLATFORM_FEE_BPS) / 10_000) + DEFAULT_PLATFORM_FEE_FIXED_CENTS
  );
}

export type FeePolicyExample = {
  ticketTypeId: string;
  ticketName: string;
  currency: string;
  priceCents: number;
  platformFeeCents: number;
  serviceFeeCents: number;
  totalFeeCents: number;
  buyerFeeCents: number;
  organizerAbsorbedFeeCents: number;
  buyerTotalCents: number;
  organizerNetCents: number;
};

export function feePolicyToValues(policy?: AdminFeePolicy): FeePolicyFormValues {
  return {
    passFeesToBuyer: policy?.passFeesToBuyer ?? false,
    rules:
      policy?.rules.map((rule) => ({
        id: rule.id,
        name: rule.name,
        type: rule.type,
        value: rule.value,
        appliedTo: rule.appliedTo,
      })) ?? [],
  };
}

export function feePolicyValuesToInput(values: FeePolicyFormValues): UpdateEventFeePolicyInput {
  return {
    passFeesToBuyer: values.passFeesToBuyer,
    rules: values.rules.map((rule) => ({
      id: rule.id,
      name: rule.name.trim(),
      type: rule.type,
      value: rule.value,
      appliedTo: rule.appliedTo,
    })),
  };
}

export function buildFeePolicyExamples(
  ticketTypes: AdminTicketType[],
  values: FeePolicyFormValues,
): FeePolicyExample[] {
  return ticketTypes.map((ticket) => {
    const serviceFeeCents = values.rules.reduce((sum, rule) => {
      const fee =
        rule.type === 'percentage'
          ? Math.round((ticket.priceCents * rule.value) / 10_000)
          : rule.value;
      return sum + fee;
    }, 0);
    const platformFeeCents = computePlatformFeeCents(ticket.priceCents);
    const totalFeeCents = serviceFeeCents + platformFeeCents;
    const buyerFeeCents = values.passFeesToBuyer ? totalFeeCents : 0;
    const organizerAbsorbedFeeCents = values.passFeesToBuyer ? 0 : totalFeeCents;
    return {
      ticketTypeId: ticket.id,
      ticketName: ticket.name,
      currency: ticket.currency,
      priceCents: ticket.priceCents,
      platformFeeCents,
      serviceFeeCents,
      totalFeeCents,
      buyerFeeCents,
      organizerAbsorbedFeeCents,
      buyerTotalCents: ticket.priceCents + buyerFeeCents,
      organizerNetCents: ticket.priceCents - organizerAbsorbedFeeCents,
    };
  });
}

export function EventFeePolicyCard({
  eventId,
  ticketTypes,
}: {
  eventId: string;
  ticketTypes: AdminTicketType[];
}) {
  const {
    data: feePolicy,
    loading,
    error,
    refetch,
  } = useAdminQuery(['getEventFeePolicy', eventId], () => adminApi.getEventFeePolicy(eventId));
  const [saving, setSaving] = React.useState(false);
  const lastSavedPolicyRef = React.useRef<string | null>(null);
  const saveVersionRef = React.useRef(0);
  const form = useForm<FeePolicyFormValues>({
    resolver: zodResolver(feePolicyFormSchema),
    defaultValues: feePolicyToValues(undefined),
  });

  const serializeValues = React.useCallback((values: FeePolicyFormValues) => {
    return JSON.stringify(feePolicyValuesToInput(values));
  }, []);

  React.useEffect(() => {
    if (feePolicy) {
      const values = feePolicyToValues(feePolicy);
      lastSavedPolicyRef.current = serializeValues(values);
      form.reset(values);
    }
  }, [feePolicy, form, serializeValues]);

  const rules = form.watch('rules');
  const passFeesToBuyer = form.watch('passFeesToBuyer');
  const examples = buildFeePolicyExamples(ticketTypes, { passFeesToBuyer, rules });

  const addRule = () => {
    form.setValue(
      'rules',
      [
        ...rules,
        {
          name: 'Service fee',
          type: 'percentage',
          value: 500,
          appliedTo: 'per_ticket',
        },
      ],
      { shouldDirty: true, shouldValidate: true },
    );
  };

  const removeRule = (index: number) => {
    form.setValue(
      'rules',
      rules.filter((_, ruleIndex) => ruleIndex !== index),
      { shouldDirty: true, shouldValidate: true },
    );
  };

  const savePolicy = React.useCallback(
    async (values: FeePolicyFormValues) => {
      const input = feePolicyValuesToInput(values);
      const policyKey = JSON.stringify(input);
      if (lastSavedPolicyRef.current === policyKey) {
        return;
      }

      const saveVersion = (saveVersionRef.current += 1);
      lastSavedPolicyRef.current = policyKey;
      setSaving(true);
      const result = await adminApi.updateEventFeePolicy(eventId, input);
      if (saveVersion === saveVersionRef.current) {
        setSaving(false);
      }
      if (!result.ok) {
        if (saveVersion === saveVersionRef.current) {
          lastSavedPolicyRef.current = null;
        }
        toast.error(result.error.message);
        return;
      }
      if (saveVersion !== saveVersionRef.current) {
        return;
      }

      const nextValues = feePolicyToValues(result.data);
      lastSavedPolicyRef.current = serializeValues(nextValues);
      form.reset(nextValues);
      await refetch();
    },
    [eventId, form, refetch, serializeValues],
  );

  React.useEffect(() => {
    if (loading || !feePolicy) {
      return;
    }

    let timeoutId: ReturnType<typeof window.setTimeout> | null = null;
    const subscription = form.watch((values) => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }

      const parsed = feePolicyFormSchema.safeParse(values);
      if (!parsed.success) {
        return;
      }

      const policyKey = serializeValues(parsed.data);
      if (lastSavedPolicyRef.current === policyKey) {
        return;
      }

      timeoutId = window.setTimeout(() => {
        void savePolicy(parsed.data);
      }, FEE_POLICY_AUTOSAVE_DELAY_MS);
    });

    return () => {
      subscription.unsubscribe();
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [feePolicy, form, loading, savePolicy, serializeValues]);

  return (
    <Card data-testid="fee-policy-card">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>Ticket Fees</CardTitle>
            <p className="text-sm text-muted-foreground">
              {passFeesToBuyer
                ? 'Buyers cover Stripe processing and your service fees at checkout'
                : 'You absorb Stripe processing and service fees from your proceeds'}
            </p>
          </div>
          <Badge variant={passFeesToBuyer ? 'default' : 'secondary'}>
            {passFeesToBuyer ? 'Buyer pays' : 'Organizer absorbs'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <Form {...form}>
            <div className="space-y-4">
              {error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  {error.message}
                </div>
              )}
              <FormField
                control={form.control}
                name="passFeesToBuyer"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-md border p-3">
                    <div className="space-y-1">
                      <FormLabel htmlFor="fee-pass-to-buyers">Pass fees to buyers</FormLabel>
                      <FormDescription>
                        When enabled, checkout totals add the Stripe processing fee and your service
                        fees on top of the ticket price. When disabled, they are deducted from your
                        proceeds.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        id="fee-pass-to-buyers"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              {rules.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  No ticket fee rules.
                </div>
              ) : (
                <div className="space-y-3">
                  {rules.map((rule, index) => (
                    <div key={`${rule.id ?? 'new'}-${index}`} className="rounded-md border p-3">
                      <div className="grid gap-3 lg:grid-cols-[1.2fr_140px_140px_120px_40px] lg:items-start">
                        <FormField
                          control={form.control}
                          name={`rules.${index}.name`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Name</FormLabel>
                              <FormControl>
                                <Input {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name={`rules.${index}.type`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Type</FormLabel>
                              <Select onValueChange={field.onChange} value={field.value}>
                                <FormControl>
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value="percentage">Percent</SelectItem>
                                  <SelectItem value="fixed">Fixed</SelectItem>
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name={`rules.${index}.appliedTo`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Applies</FormLabel>
                              <Select onValueChange={field.onChange} value={field.value}>
                                <FormControl>
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value="per_ticket">Per ticket</SelectItem>
                                  <SelectItem value="per_order">Per order</SelectItem>
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name={`rules.${index}.value`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>
                                {rule.type === 'percentage' ? 'Rate (%)' : 'Amount ($)'}
                              </FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  min={0}
                                  step={0.01}
                                  value={field.value / 100}
                                  onChange={(event) =>
                                    field.onChange(
                                      Math.round(Number(event.currentTarget.value || 0) * 100),
                                    )
                                  }
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <div className="flex lg:pt-8">
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            onClick={() => removeRule(index)}
                            aria-label="Remove fee rule"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <FeePolicyExplanation examples={examples} passFeesToBuyer={passFeesToBuyer} />

              <div className="flex flex-wrap justify-between gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={addRule}
                  disabled={rules.length >= 5}
                >
                  <Plus className="size-4" />
                  Add Fee
                </Button>
              </div>
            </div>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}

function FeePolicyExplanation({
  examples,
  passFeesToBuyer,
}: {
  examples: FeePolicyExample[];
  passFeesToBuyer: boolean;
}) {
  if (examples.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        Create ticket types to preview fee impact by price.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-sm text-muted-foreground">
        Every paid ticket includes the Stripe processing fee (2.9% + $0.30).{' '}
        {passFeesToBuyer
          ? 'With pass-through on, buyers pay this plus your service fees on top of the ticket price, so you keep the full face value.'
          : 'With pass-through off, buyers pay face value and these fees are deducted from your proceeds.'}
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Ticket type</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Platform fee</TableHead>
              <TableHead>Service fees</TableHead>
              <TableHead>Buyer total</TableHead>
              <TableHead>Organizer net</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {examples.map((example) => (
              <TableRow key={example.ticketTypeId}>
                <TableCell className="font-medium">{example.ticketName}</TableCell>
                <TableCell>{formatCurrency(example.priceCents, example.currency)}</TableCell>
                <TableCell>{formatCurrency(example.platformFeeCents, example.currency)}</TableCell>
                <TableCell>{formatCurrency(example.serviceFeeCents, example.currency)}</TableCell>
                <TableCell>{formatCurrency(example.buyerTotalCents, example.currency)}</TableCell>
                <TableCell>{formatCurrency(example.organizerNetCents, example.currency)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
