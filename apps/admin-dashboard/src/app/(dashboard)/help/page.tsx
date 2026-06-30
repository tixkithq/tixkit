import Link from 'next/link';
import {
  BookOpen,
  CheckCircle2,
  Code2,
  HelpCircle,
  LifeBuoy,
  MessageSquare,
  QrCode,
  Settings,
  ShoppingCart,
  Ticket,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { routes } from '@/lib/routes';

const guideCards = [
  {
    title: 'Launch an event',
    description: 'Create the event, configure tickets, preview checkout, and publish safely.',
    href: '#launch-event',
    icon: Ticket,
    time: '8 min',
  },
  {
    title: 'Sell and refund orders',
    description: 'Track paid orders, issue full or partial refunds, and understand order states.',
    href: '#orders-refunds',
    icon: ShoppingCart,
    time: '6 min',
  },
  {
    title: 'Run check-in',
    description: 'Use the scanner, choose the right check-in list, and handle duplicates.',
    href: '#check-in',
    icon: QrCode,
    time: '5 min',
  },
  {
    title: 'Developer setup',
    description: 'Create API keys, configure webhooks, verify signatures, and replay events.',
    href: '#developer-api',
    icon: Code2,
    time: '7 min',
  },
] as const;

const troubleshooting = [
  {
    problem: 'A paid checkout did not issue tickets.',
    action:
      'Open Orders, search by buyer email or payment reference, and check the order timeline before retrying or refunding.',
  },
  {
    problem: 'A scanner says a ticket is duplicate.',
    action:
      'Confirm the selected event and check-in list, then review the attendee status before overriding at the door.',
  },
  {
    problem: 'Webhook delivery failed.',
    action:
      'Open Developer > Webhooks, inspect the endpoint status and recent events, then replay after the destination is healthy.',
  },
  {
    problem: 'A report looks incomplete.',
    action:
      'Verify the date range, event selection, refund state, and export status before sharing the numbers externally.',
  },
] as const;

export default function Page() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Help</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Step-by-step dashboard guides for organizers, operators, and developers working in
            Tixkit.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="#troubleshooting">
            <LifeBuoy className="size-4" />
            Troubleshooting
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {guideCards.map((guide) => {
          const Icon = guide.icon;
          return (
            <a
              key={guide.href}
              href={guide.href}
              aria-label={`Open guide: ${guide.title}`}
              className="block rounded-xl outline-none"
            >
              <Card className="h-full transition-colors hover:bg-muted/40 focus-within:ring-2 focus-within:ring-ring">
                <CardHeader className="gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex size-10 items-center justify-center rounded-md bg-muted">
                      <Icon className="size-5 text-muted-foreground" />
                    </div>
                    <Badge variant="outline">{guide.time}</Badge>
                  </div>
                  <div className="space-y-1">
                    <CardTitle>{guide.title}</CardTitle>
                    <CardDescription>{guide.description}</CardDescription>
                  </div>
                </CardHeader>
              </Card>
            </a>
          );
        })}
      </div>

      <GuideSection
        id="first-run"
        icon={Settings}
        eyebrow="First run"
        title="Set up the workspace before selling"
        summary="Confirm the organization, brand, payments, members, and public presentation before inviting buyers."
        steps={[
          'Open Workspace and confirm the organization name, primary brand, and member access.',
          'Open Brand and set the buyer-facing name, primary color, and verified domains when available.',
          'Open Payments and connect or refresh the payment account before publishing paid tickets.',
          'Open Members and invite operators with the smallest permission set they need.',
        ]}
        links={[
          { label: 'Workspace settings', href: routes.settingsWorkspace },
          { label: 'Brand settings', href: routes.settingsBranding },
          { label: 'Payments', href: routes.settingsPayments },
        ]}
      />

      <GuideSection
        id="launch-event"
        icon={Ticket}
        eyebrow="Events"
        title="Create, configure, and publish an event"
        summary="Build the event in small checks: event details first, ticket inventory second, checkout behavior third."
        steps={[
          'Create the event from Events and keep it in draft while ticketing is incomplete.',
          'Add ticket types with clear names, prices, capacity, and visibility rules.',
          'Configure checkout questions and consent text before sharing the public link.',
          'Use the event detail quick links to review tickets, messages, reports, and public checkout.',
          'Publish only after the public page, checkout, payment account, and confirmation email path are ready.',
        ]}
        links={[
          { label: 'Events', href: routes.events },
          { label: 'Reports', href: routes.reports },
        ]}
      />

      <GuideSection
        id="orders-refunds"
        icon={ShoppingCart}
        eyebrow="Orders"
        title="Track orders and process refunds"
        summary="Use order detail as the source of truth for buyer state, line items, attendees, refunds, and timeline activity."
        steps={[
          'Search Orders by buyer name, email, or order status.',
          'Open order detail before taking action so you can review line items, attendees, and prior refunds.',
          'Use full refund when the full remaining balance should be returned.',
          'Use partial refund when only part of the order should be returned, and record a specific reason.',
          'Void tickets and restore inventory only when the operational outcome requires those changes.',
        ]}
        links={[
          { label: 'Orders', href: routes.orders },
          { label: 'Attendees', href: routes.attendees },
        ]}
      />

      <GuideSection
        id="check-in"
        icon={QrCode}
        eyebrow="Check-in"
        title="Run door scanning"
        summary="Pick the correct event and list before scanning. Treat duplicate or revoked results as operational exceptions."
        steps={[
          'Open Check-in and select the event being admitted.',
          'Choose the correct check-in list for the door, session, or zone.',
          'Scan QR codes and confirm accepted, duplicate, revoked, or invalid results before moving to the next attendee.',
          'Use manual lookup when a QR code is damaged or the attendee needs identity confirmation.',
          'After the door opens, monitor duplicate and invalid scans for training or fraud signals.',
        ]}
        links={[
          { label: 'Check-in', href: routes.checkIn },
          { label: 'Attendees', href: routes.attendees },
        ]}
      />

      <GuideSection
        id="messages-reports"
        icon={MessageSquare}
        eyebrow="Messaging and reports"
        title="Communicate and measure"
        summary="Send messages to scoped audiences, then use reports and exports to verify sales, attendance, and campaign outcomes."
        steps={[
          'Create event messages from Messages or from the event detail message surface.',
          'Preview recipients before sending so suppression, consent, and eligibility rules are visible.',
          'Review queued, delivered, failed, and suppressed counts separately after send.',
          'Use Reports for sales and export workflows; verify date range and event selection before sharing.',
        ]}
        links={[
          { label: 'Messages', href: routes.messages },
          { label: 'Reports', href: routes.reports },
        ]}
      />

      <GuideSection
        id="developer-api"
        icon={Code2}
        eyebrow="Developers"
        title="Use API keys and webhooks safely"
        summary="API keys are scoped credentials. Webhooks are signed event deliveries that should be verified before processing."
        steps={[
          'Create API keys only for server-side integrations and choose the narrowest scopes possible.',
          'Store the one-time API key secret immediately; it will not be shown again.',
          'Create webhook endpoints with HTTPS URLs and select only the events the destination needs.',
          'Verify webhook signatures and timestamps before trusting the payload.',
          'Replay webhook events only after the destination bug or outage has been fixed.',
        ]}
        links={[
          { label: 'Developer overview', href: routes.developer },
          { label: 'API keys', href: routes.developerApiKeys },
          { label: 'Webhooks', href: routes.developerWebhooks },
        ]}
      />

      <Card id="troubleshooting">
        <CardHeader>
          <div className="flex items-center gap-2">
            <HelpCircle className="size-5 text-muted-foreground" />
            <CardTitle>Troubleshooting quick checks</CardTitle>
          </div>
          <CardDescription>
            Start with the dashboard record that owns the state, then use the timeline, delivery
            state, or export result before retrying an action.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2">
            {troubleshooting.map((item) => (
              <div key={item.problem} className="rounded-lg border p-4">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <CheckCircle2 className="size-4 text-muted-foreground" />
                  {item.problem}
                </div>
                <p className="text-sm text-muted-foreground">{item.action}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function GuideSection({
  id,
  icon: Icon,
  eyebrow,
  title,
  summary,
  steps,
  links,
}: {
  id: string;
  icon: typeof BookOpen;
  eyebrow: string;
  title: string;
  summary: string;
  steps: string[];
  links: Array<{ label: string; href: string }>;
}) {
  return (
    <Card id={id}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <Badge variant="outline">{eyebrow}</Badge>
            <div className="flex items-center gap-2">
              <Icon className="size-5 text-muted-foreground" />
              <CardTitle>{title}</CardTitle>
            </div>
            <CardDescription>{summary}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="grid gap-3 md:grid-cols-2">
          {steps.map((step, index) => (
            <li key={step} className="flex gap-3 rounded-lg border p-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-medium">
                {index + 1}
              </span>
              <span className="text-sm leading-6">{step}</span>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2">
          {links.map((link) => (
            <Button key={link.href} variant="outline" size="sm" asChild>
              <Link href={link.href}>{link.label}</Link>
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
