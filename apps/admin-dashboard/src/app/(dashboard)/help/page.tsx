'use client';

import { dashboardHelpRegistry, filterHelpByPermissions, type DocRouteId } from '@tixkit/docs-core';
import { BookOpen, Search, ShieldAlert } from 'lucide-react';
import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { usePermissions } from '@/context/permission-provider';
import { dashboardDocUrl } from '@/lib/docs';

const audiencePaths: ReadonlyArray<{
  title: string;
  summary: string;
  routeId: DocRouteId;
}> = [
  { title: 'Organizer', summary: 'Configure and publish an event.', routeId: 'firstEvent' },
  { title: 'Box office', summary: 'Create supervised event orders.', routeId: 'boxOffice' },
  { title: 'Door staff', summary: 'Prepare scanners and run check-in.', routeId: 'checkIn' },
  {
    title: 'Developer',
    summary: 'Create a scoped key and make a first call.',
    routeId: 'firstApiCall',
  },
  {
    title: 'Self-hoster',
    summary: 'Deploy and operate the complete stack.',
    routeId: 'selfHostingDeployment',
  },
];

function DocLink({ routeId, children }: { routeId: DocRouteId; children: React.ReactNode }) {
  return (
    <a
      className="text-sm font-medium text-primary underline-offset-4 hover:underline"
      href={dashboardDocUrl(routeId)}
    >
      {children}
    </a>
  );
}

export default function HelpPage() {
  const { permissions, loading, error } = usePermissions();
  const [query, setQuery] = React.useState('');
  const permittedEntries = filterHelpByPermissions(dashboardHelpRegistry, new Set(permissions));
  const normalizedQuery = query.trim().toLowerCase();
  const results = permittedEntries.filter((entry) => {
    if (!normalizedQuery) return true;
    return [
      entry.title,
      entry.summary,
      ...entry.keywords,
      ...entry.commonTasks.map((task) => task.label),
      ...entry.troubleshooting.map((item) => item.symptom),
    ]
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery);
  });
  const troubleshooting = permittedEntries
    .flatMap((entry) => entry.troubleshooting)
    .filter(
      (item, index, items) =>
        items.findIndex((candidate) => candidate.symptom === item.symptom) === index,
    );

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <BookOpen className="size-6" aria-hidden="true" />
          <h1 className="text-2xl font-bold tracking-tight">Help Center</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Find a task, diagnose a symptom, or open the exact public guide for your current role.
        </p>
      </header>

      <div className="relative max-w-2xl">
        <Search
          className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search tasks and symptoms"
          aria-label="Search Help Center"
          className="pl-9"
        />
      </div>

      {error ? (
        <output className="flex max-w-3xl gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <ShieldAlert className="mt-0.5 size-5 text-destructive" aria-hidden="true" />
          <div>
            <p className="font-medium">Permission-aware Help is unavailable</p>
            <p className="text-sm text-muted-foreground">
              Reload your session before following a privileged setup action. Public guides remain
              available.
            </p>
          </div>
        </output>
      ) : null}

      <section aria-labelledby="help-by-role">
        <h2 id="help-by-role" className="mb-3 text-lg font-semibold">
          Start by role
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {audiencePaths.map((path) => (
            <Card key={path.title}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{path.title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">{path.summary}</p>
                <DocLink routeId={path.routeId}>Open guide</DocLink>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section aria-labelledby="help-tasks">
        <h2 id="help-tasks" className="mb-3 text-lg font-semibold">
          {normalizedQuery ? 'Search results' : 'Tasks by product area'}
        </h2>
        {loading ? (
          <output className="block text-sm text-muted-foreground">
            Loading permission-aware Help…
          </output>
        ) : null}
        {!loading && results.length === 0 ? (
          <output className="block rounded-lg border p-4 text-sm">
            No permitted Help entries match “{query}”. Try a product name or symptom.
          </output>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {results.map((entry) => (
            <Card key={entry.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{entry.title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">{entry.summary}</p>
                <DocLink routeId={entry.docRouteId}>Open overview</DocLink>
                {entry.commonTasks.length > 0 ? (
                  <ul className="space-y-1 text-sm">
                    {entry.commonTasks.map((task) => (
                      <li key={`${entry.id}-${task.label}`}>
                        <DocLink routeId={task.docRouteId}>{task.label}</DocLink>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {!normalizedQuery ? (
        <section aria-labelledby="help-troubleshooting">
          <h2 id="help-troubleshooting" className="mb-3 text-lg font-semibold">
            Troubleshoot by symptom
          </h2>
          <div className="divide-y rounded-lg border bg-card">
            {troubleshooting.map((item) => (
              <div
                className="flex flex-wrap items-center justify-between gap-3 p-3"
                key={item.symptom}
              >
                <span className="text-sm">{item.symptom}</span>
                <DocLink routeId={item.docRouteId}>Diagnose</DocLink>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <p className="text-sm text-muted-foreground">
        Need repository, security, or community support?{' '}
        <DocLink routeId="support">Choose a support path</DocLink>.
      </p>
    </div>
  );
}
