'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { publicApi, type Buyer, type CheckoutQuestion } from '@/lib/api';
import {
  type CheckoutAnswers,
  type CheckoutAnswerValue,
  isCheckoutQuestionVisible,
} from '@/lib/checkout-questions';

export type AttendeeAnswers = CheckoutAnswers;

type AttendeeQuestionGroup = {
  lineId: string;
  ticketTypeId: string;
  ticketName: string;
  quantity: number;
  questions: CheckoutQuestion[];
};

type Props = {
  buyer: Buyer;
  onChange: (buyer: Buyer) => void;
  disabled: boolean;
  emailError?: string;
  /** Dynamic buyer questions rendered after the standard fields. */
  buyerQuestions?: CheckoutQuestion[];
  /** Buyer question answers keyed by question id. */
  buyerAnswers?: AttendeeAnswers;
  /** Callback when buyer question answers change. */
  onBuyerAnswersChange?: (answers: AttendeeAnswers) => void;
  /** Per-attendee question answers, keyed by `${lineId}:${attendeeIndex}`. */
  attendeeQuestionGroups?: AttendeeQuestionGroup[];
  /** Per-attendee answers keyed by `${lineId}:${attendeeIndex}:${questionId}`. */
  attendeeAnswers?: CheckoutAnswers;
  /** Callback when attendee answers change. */
  onAttendeeAnswersChange?: (answers: CheckoutAnswers) => void;
  eventId?: string;
};

const EMPTY_BUYER_QUESTIONS: CheckoutQuestion[] = [];
const EMPTY_BUYER_ANSWERS: AttendeeAnswers = {};
const EMPTY_ATTENDEE_QUESTION_GROUPS: AttendeeQuestionGroup[] = [];
const EMPTY_ATTENDEE_ANSWERS: CheckoutAnswers = {};

export function AttendeeForm({
  buyer,
  onChange,
  disabled,
  emailError,
  buyerQuestions = EMPTY_BUYER_QUESTIONS,
  buyerAnswers = EMPTY_BUYER_ANSWERS,
  onBuyerAnswersChange,
  attendeeQuestionGroups = EMPTY_ATTENDEE_QUESTION_GROUPS,
  attendeeAnswers = EMPTY_ATTENDEE_ANSWERS,
  onAttendeeAnswersChange,
  eventId,
}: Props) {
  const emailFeedbackId = 'email_feedback';

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="email">
          Email <span className="text-destructive">*</span>
        </Label>
        <Input
          id="email"
          name="email"
          type="email"
          value={buyer.email}
          onChange={(e) => onChange({ ...buyer, email: e.target.value })}
          autoComplete="email"
          required
          disabled={disabled}
          aria-invalid={Boolean(emailError)}
          aria-describedby={emailFeedbackId}
        />
        {emailError ? (
          <p id={emailFeedbackId} className="text-sm text-destructive">
            {emailError}
          </p>
        ) : (
          <p id={emailFeedbackId} className="text-xs text-muted-foreground">
            Your tickets and receipt will be sent here.
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="firstName">First name</Label>
          <Input
            id="firstName"
            name="firstName"
            value={buyer.firstName}
            onChange={(e) => onChange({ ...buyer, firstName: e.target.value })}
            autoComplete="given-name"
            disabled={disabled}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="lastName">Last name</Label>
          <Input
            id="lastName"
            name="lastName"
            value={buyer.lastName}
            onChange={(e) => onChange({ ...buyer, lastName: e.target.value })}
            autoComplete="family-name"
            disabled={disabled}
          />
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="phone">Phone</Label>
        <Input
          id="phone"
          name="phone"
          type="tel"
          value={buyer.phone}
          onChange={(e) => onChange({ ...buyer, phone: e.target.value })}
          autoComplete="tel"
          disabled={disabled}
        />
      </div>

      {buyerQuestions.length > 0 ? (
        <div className="space-y-4 border-t pt-4">
          <p className="text-sm font-medium">Additional information</p>
          {buyerQuestions
            .filter((q) => isCheckoutQuestionVisible(q, buyerAnswers))
            .map((q) => (
              <DynamicQuestionField
                key={q.id}
                question={q}
                value={buyerAnswers[q.id] ?? ''}
                disabled={disabled}
                eventId={eventId}
                onChange={(val) => onBuyerAnswersChange?.({ ...buyerAnswers, [q.id]: val })}
              />
            ))}
        </div>
      ) : null}

      {attendeeQuestionGroups.map((group) => {
        if (group.questions.length === 0 || group.quantity === 0) return null;
        return (
          <div key={group.lineId} className="space-y-4 border-t pt-4">
            <p className="text-sm font-medium">{group.ticketName} - attendee details</p>
            {Array.from({ length: group.quantity }, (_, i) => (
              <div
                key={`${group.lineId}:${i}`}
                className="space-y-3 rounded-md border bg-muted/30 p-3"
              >
                <p className="text-xs font-medium text-muted-foreground">Attendee {i + 1}</p>
                {group.questions
                  .filter((q) => {
                    const answersForAttendee = Object.fromEntries(
                      group.questions.map((question) => [
                        question.id,
                        attendeeAnswers[`${group.lineId}:${i}:${question.id}`],
                      ]),
                    );
                    return isCheckoutQuestionVisible(q, answersForAttendee);
                  })
                  .map((q) => {
                    const key = `${group.lineId}:${i}:${q.id}`;
                    return (
                      <DynamicQuestionField
                        key={key}
                        question={q}
                        value={attendeeAnswers[key] ?? ''}
                        disabled={disabled}
                        eventId={eventId}
                        onChange={(val) =>
                          onAttendeeAnswersChange?.({
                            ...attendeeAnswers,
                            [key]: val,
                          })
                        }
                      />
                    );
                  })}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function DynamicQuestionField({
  question,
  value,
  disabled,
  eventId,
  onChange,
}: {
  question: CheckoutQuestion;
  value: CheckoutAnswerValue | '';
  disabled: boolean;
  eventId?: string;
  onChange: (value: CheckoutAnswerValue) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const id = `q_${question.id}`;
  const stringValue = typeof value === 'string' ? value : '';
  const label = (
    <Label htmlFor={id}>
      {question.label}
      {question.required ? <span className="text-destructive"> *</span> : null}
    </Label>
  );

  if (question.type === 'checkbox') {
    return (
      <div className="flex items-center gap-2">
        <input
          id={id}
          name={question.id}
          type="checkbox"
          checked={value === true || value === 'true'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="size-4 rounded border-input accent-primary"
        />
        <Label htmlFor={id} className="text-sm font-normal">
          {question.label}
        </Label>
      </div>
    );
  }

  if (question.type === 'textarea') {
    return (
      <div className="grid gap-2">
        {label}
        <Textarea
          id={id}
          name={question.id}
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={question.placeholder}
          required={question.required}
        />
      </div>
    );
  }

  if (question.type === 'select') {
    return (
      <div className="grid gap-2">
        {label}
        <select
          id={id}
          name={question.id}
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          required={question.required}
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">Select…</option>
          {question.options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (question.type === 'multiselect') {
    // Multi-checkbox group. The selected values are joined with commas so
    // the existing string-based answer store works without schema changes.
    const selected = value
      ? Array.isArray(value)
        ? value.map((v) => String(v))
        : String(value)
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
      : [];

    const toggle = (opt: string) => {
      const next = selected.includes(opt) ? selected.filter((v) => v !== opt) : [...selected, opt];
      onChange(next);
    };

    return (
      <fieldset className="grid gap-2" id={id} name={question.id}>
        {label}
        <div className="space-y-2">
          {question.options?.map((opt) => {
            const optId = `${id}_${opt}`;
            return (
              <div key={opt} className="flex items-center gap-2">
                <input
                  id={optId}
                  name={question.id}
                  type="checkbox"
                  checked={selected.includes(opt)}
                  disabled={disabled}
                  onChange={() => toggle(opt)}
                  className="size-4 rounded border-input accent-primary"
                />
                <Label htmlFor={optId} className="text-sm font-normal">
                  {opt}
                </Label>
              </div>
            );
          })}
        </div>
        {/* Hidden input carries the joined value for form submission and
            required-validation by the browser when no option is checked. */}
        <input
          type="hidden"
          name={question.id}
          value={selected.join(', ')}
          required={question.required}
        />
        {question.description ? (
          <p className="text-xs text-muted-foreground">{question.description}</p>
        ) : null}
      </fieldset>
    );
  }

  if (question.type === 'file') {
    const uploaded =
      value && typeof value === 'object' && !Array.isArray(value) && 'artifactId' in value
        ? value
        : null;
    return (
      <div className="grid gap-2">
        {label}
        <Input
          id={id}
          type="file"
          disabled={disabled || uploading || !eventId}
          required={question.required && !uploaded}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file || !eventId) return;
            setUploading(true);
            setUploadError(null);
            try {
              const artifact = await publicApi.uploadCheckoutArtifact(eventId, file, question.id);
              onChange(artifact);
            } catch (err) {
              setUploadError(err instanceof Error ? err.message : 'File upload failed');
              event.target.value = '';
            } finally {
              setUploading(false);
            }
          }}
        />
        {uploaded ? (
          <p className="text-xs text-muted-foreground">Uploaded {uploaded.fileName ?? 'file'}</p>
        ) : uploading ? (
          <p className="text-xs text-muted-foreground">Uploading file...</p>
        ) : uploadError ? (
          <p className="text-xs text-destructive">{uploadError}</p>
        ) : null}
        {question.description ? (
          <p className="text-xs text-muted-foreground">{question.description}</p>
        ) : null}
      </div>
    );
  }

  if (question.type === 'waiver') {
    return (
      <div className="grid gap-2">
        <div className="flex items-center gap-2">
          <input
            id={id}
            name={question.id}
            type="checkbox"
            checked={value === true || value === 'true'}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
            className="size-4 rounded border-input accent-primary"
          />
          {label}
        </div>
        {question.description ? (
          <p className="text-xs text-muted-foreground">{question.description}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {label}
      <Input
        id={id}
        name={question.id}
        type={
          question.type === 'email'
            ? 'email'
            : question.type === 'phone'
              ? 'tel'
              : question.type === 'date'
                ? 'date'
                : 'text'
        }
        value={stringValue}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={question.placeholder}
        required={question.required}
      />
      {question.description ? (
        <p className="text-xs text-muted-foreground">{question.description}</p>
      ) : null}
    </div>
  );
}
