import Link from 'next/link';
import { docRoutes } from '@tixkit/docs-core';
import { adoptionPaths } from '../lib/adoption-paths';

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
        <h2 id="choose-path">How do you want to use Tixkit?</h2>
        <div className="path-grid">
          {adoptionPaths.map((path) => (
            <Link key={path.href} href={path.href}>
              <h3>{path.title}</h3>
              <p>{path.description}</p>
              <span>Start →</span>
            </Link>
          ))}
        </div>
      </section>
      <section className="architecture-summary" aria-labelledby="shared-contract">
        <h2 id="shared-contract">One shared product contract</h2>
        <p>
          Every path uses the same event, inventory, checkout, order, attendee, webhook, migration,
          OpenAPI, and SDK contracts. Choose a path first; its guide introduces only the concepts
          needed for that journey.
        </p>
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
