import Link from 'next/link';
import { docRoutes } from '@tixkit/docs-core';

const paths = [
  {
    title: 'Run Tixkit locally',
    description: 'Start the complete local stack and verify every service.',
    href: docRoutes.localQuickstart,
  },
  {
    title: 'Operate an event',
    description: 'Create inventory, test checkout, publish, and prepare check-in.',
    href: docRoutes.firstEvent,
  },
  {
    title: 'Build an integration',
    description: 'Choose an SDK, create a scoped key, and make a safe first call.',
    href: docRoutes.firstApiCall,
  },
  {
    title: 'Deploy and self-host',
    description: 'Choose a topology and configure durable production services.',
    href: docRoutes.selfHostingDeployment,
  },
];

export default function HomePage() {
  return (
    <div className="home">
      <section className="hero">
        <p className="eyebrow">Open-source event commerce</p>
        <h1>Build and operate reliable ticketing workflows.</h1>
        <p>
          Tixkit is a headless, white-label platform for event inventory, checkout, orders,
          attendees, messaging, and integrations. These guides separate stable behavior from
          experimental and environment-specific capabilities.
        </p>
      </section>
      <section aria-labelledby="choose-path">
        <h2 id="choose-path">Choose your path</h2>
        <div className="path-grid">
          {paths.map((path) => (
            <Link key={path.href} href={path.href}>
              <h3>{path.title}</h3>
              <p>{path.description}</p>
              <span>Start →</span>
            </Link>
          ))}
        </div>
      </section>
      <section className="architecture-summary" aria-labelledby="architecture-at-a-glance">
        <h2 id="architecture-at-a-glance">Architecture at a glance</h2>
        <p>
          The admin and hosted checkout call a tenant-scoped Fastify API. Kysely repositories
          persist operational state, while Temporal owns durable workflows. OpenAPI is the contract
          source for public endpoints and SDK parity.
        </p>
        <Link href={docRoutes.selfHostingArchitecture}>Explore the architecture</Link>
      </section>
      <section aria-labelledby="supported-sdks">
        <h2 id="supported-sdks">Supported SDK paths</h2>
        <p>
          Start with JavaScript, Next.js, SvelteKit, Vue/Nuxt, Astro, Remix, React Native, Flutter,
          iOS, Android, Go, or Rust. Each guide states its runtime and support status.
        </p>
        <div className="home-links">
          <Link href={docRoutes.sdkJavaScript}>Browse SDK guides</Link>
          <Link href={docRoutes.apiReference}>API reference</Link>
          <Link href={docRoutes.webhookEvents}>Webhook events</Link>
        </div>
      </section>
    </div>
  );
}
