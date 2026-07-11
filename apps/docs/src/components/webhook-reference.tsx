import { webhookReferenceEvents } from '@/generated/webhook-reference';

export function WebhookReference() {
  return (
    <div className="webhook-reference">
      {webhookReferenceEvents.map((event) => (
        <article key={event.type} id={`event-${event.type.replaceAll('.', '-')}`}>
          <h2>
            <code>{event.type}</code>
            <a
              className="heading-anchor"
              href={`#event-${event.type.replaceAll('.', '-')}`}
              aria-label={`Link to ${event.type}`}
            >
              #
            </a>
          </h2>
          <p>
            <strong>Status:</strong> {event.stability}
          </p>
          <p>{event.trigger}</p>
          <p>
            <strong>Payload data fields:</strong>{' '}
            {event.fields
              .map((field) => <code key={field}>{field}</code>)
              .reduce(
                (nodes, node, index) => (index === 0 ? [node] : [...nodes, ', ', node]),
                [] as React.ReactNode[],
              )}
          </p>
          <pre>
            <code className="language-json">
              {JSON.stringify(
                {
                  id: 'wevt_example',
                  type: event.type,
                  apiVersion: '2026-01-01',
                  createdAt: '2026-07-10T12:00:00.000Z',
                  tenantId: 'tnt_example',
                  organizationId: 'org_example',
                  data: event.example,
                },
                null,
                2,
              )}
            </code>
          </pre>
        </article>
      ))}
    </div>
  );
}
