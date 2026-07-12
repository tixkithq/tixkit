import { docRoutes } from '@tixkit/docs-core';

export const adoptionPaths = [
  {
    title: 'Sell tickets with Tixkit',
    description: 'Create an event, publish checkout, manage orders, and run event day.',
    href: docRoutes.sellTickets,
  },
  {
    title: 'Add ticketing to my product',
    description: 'Use the Platform API, SDKs, webhooks, and embedded buyer experiences.',
    href: docRoutes.platformApi,
  },
  {
    title: 'Run Tixkit on my infrastructure',
    description: 'Choose the Compact or Production Self-Hosted profile and operate it yourself.',
    href: docRoutes.selfHosted,
  },
] as const;
