'use client';

import * as React from 'react';
import {
  GENERIC_CSV_ENTITY_TYPES,
  createGenericCsvErrorExport,
  assertGenericCsvByteSize,
  createGenericCsvTemplate,
  previewGenericCsv,
  type GenericCsvEntityType,
  type GenericCsvPreview,
} from '@tixkit/migration-core';
import { AlertCircle, Download, FileUp, LoaderCircle, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useBootstrap } from '@/context/bootstrap-provider';
import { usePermissions } from '@/context/permission-provider';
import {
  adminApi,
  type AdminMigrationAdapter,
  type AdminMigrationJob,
  type ApiResult,
  type CreateAdminMigrationJobInput,
} from '@/lib/api';

const EMPTY_MAPPING = '{\n  "external_id": "external_id"\n}';

function messageOf(result: ApiResult<unknown>): string {
  return result.ok ? 'Operation completed.' : result.error.message;
}

function downloadText(name: string, text: string, type = 'text/plain;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function jsonSummary(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function sourceIdentifiers(value: string): string[] {
  return value
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function rollbackEligible(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'eligible' in value &&
    (value as { eligible?: unknown }).eligible === true,
  );
}

function numericEntries(value: unknown): [string, number][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number',
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function reportCounts(value: unknown): [string, number][] {
  return numericEntries(recordValue(recordValue(value).report).counts);
}

function reportList(value: unknown, key: string): unknown[] {
  const envelope = recordValue(value);
  const report = recordValue(envelope.report);
  const candidate =
    key === 'conflicts' || key === 'correctivePlans'
      ? envelope[key]
      : (report[key] ?? (key === 'unsupported' ? report.unsupportedFeatures : undefined));
  return Array.isArray(candidate) ? candidate : [];
}

function reportSeverityCounts(value: unknown): [string, number][] {
  return numericEntries(recordValue(recordValue(value).report).severityCounts);
}

function migrationEventSummary(value: unknown): string {
  const event = recordValue(value);
  const data = recordValue(event.data);
  const type = String(event.type ?? 'progress');
  const severity = typeof event.severity === 'string' ? event.severity : undefined;
  const message = typeof event.message === 'string' ? event.message : undefined;
  const processed = data.processed;
  const total = data.total;
  const checkpoint = data.checkpoint;
  const code = data.errorCode;
  const progress =
    typeof processed === 'number'
      ? `: ${processed.toLocaleString()}${typeof total === 'number' ? ` of ${total.toLocaleString()}` : ''} rows`
      : '';
  const safeDetails = [
    severity,
    typeof code === 'string' ? code : undefined,
    typeof checkpoint === 'string' ? `checkpoint ${checkpoint}` : undefined,
    message,
  ].filter(Boolean);
  return `${type}${progress}${safeDetails.length ? ` — ${safeDetails.join(' · ')}` : ''}`;
}

function lastFailureEvent(
  events: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event &&
      (/fail|error|recover/iu.test(String(event.type ?? '')) ||
        ['error', 'fatal'].includes(String(event.severity ?? '')))
    )
      return event;
  }
  return undefined;
}

export function MigrationWorkspace() {
  const {
    organizations,
    organizationId,
    setOrganizationId,
    loading: contextLoading,
  } = useBootstrap();
  const { can } = usePermissions();
  const canWrite = can('migrations.write');
  const canCommit = can('migrations.commit');
  const canRollback = can('migrations.rollback');
  const [adapters, setAdapters] = React.useState<AdminMigrationAdapter[]>([]);
  const [jobs, setJobs] = React.useState<AdminMigrationJob[]>([]);
  const [adapterId, setAdapterId] = React.useState('generic-csv');
  const [version, setVersion] = React.useState('');
  const [sourceMode, setSourceMode] = React.useState<'official-api' | 'official-export'>(
    'official-export',
  );
  const [credentialId, setCredentialId] = React.useState('');
  const [selectedJobId, setSelectedJobId] = React.useState('');
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);
  const [uploadedArtifactId, setUploadedArtifactId] = React.useState('');
  const [apiScope, setApiScope] = React.useState({
    organizerSlug: '',
    accountId: '',
    organizationId: '',
    eventIds: '',
    eventSlugs: '',
    baseUrl: '',
  });
  const [preview, setPreview] = React.useState<GenericCsvPreview | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [mappingName, setMappingName] = React.useState('Generic CSV mapping');
  const [mappingEntity, setMappingEntity] = React.useState<GenericCsvEntityType>('event');
  const [mappingText, setMappingText] = React.useState(EMPTY_MAPPING);
  const [mappingError, setMappingError] = React.useState<string | null>(null);
  const [report, setReport] = React.useState<unknown>(null);
  const [assessment, setAssessment] = React.useState<unknown>(null);
  const [commitConfirmation, setCommitConfirmation] = React.useState('');
  const [rollbackConfirmation, setRollbackConfirmation] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState('Migration workspace ready.');
  const [operationError, setOperationError] = React.useState<string | null>(null);
  const [migrationEvents, setMigrationEvents] = React.useState<Record<string, unknown>[]>([]);
  const previousStatus = React.useRef<Record<string, string>>({});

  const selectedAdapter = adapters.find((adapter) => adapter.id === adapterId);
  const selectedJob = jobs.find((job) => job.id === selectedJobId);
  const selectedJobMatchesWorkspace = Boolean(
    selectedJob &&
    selectedJob.organization_id === organizationId &&
    selectedJob.source_system === adapterId &&
    selectedJob.adapter_version === version,
  );
  const genericCsv = adapterId === 'generic-csv';
  const activeJob = Boolean(
    selectedJob &&
    ['preparing', 'running', 'committing', 'rolling-back'].includes(selectedJob.status),
  );
  const lastMigrationEvent = migrationEvents.at(-1);
  const lastFailure = lastFailureEvent(migrationEvents);

  const fail = React.useCallback((message: string) => {
    setOperationError(message);
    setAnnouncement(message);
  }, []);

  const loadAdapters = React.useCallback(async () => {
    try {
      const result = await adminApi.listMigrationAdapters();
      if (!result.ok) {
        fail(result.error.message);
        return;
      }
      setAdapters(result.data.items);
      setAdapterId((current) =>
        result.data.items.some((item) => item.id === current)
          ? current
          : result.data.items[0]?.id || '',
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Unable to load migration adapters.');
    }
  }, [fail]);

  const loadJobs = React.useCallback(async () => {
    if (!organizationId) {
      setJobs([]);
      setSelectedJobId('');
      return;
    }
    try {
      const result = await adminApi.listMigrationJobs(organizationId);
      if (!result.ok) {
        fail(result.error.message);
        return;
      }
      setJobs(result.data.items);
      setSelectedJobId((current) => {
        const matching = result.data.items.filter(
          (job) =>
            job.organization_id === organizationId &&
            job.source_system === adapterId &&
            job.adapter_version === version,
        );
        const selected = matching.find((job) => job.id === current) ?? matching[0];
        if (selected) {
          const prior = previousStatus.current[selected.id];
          previousStatus.current[selected.id] = selected.status;
          if (
            prior &&
            prior !== selected.status &&
            !['preparing', 'running', 'committing', 'rolling-back'].includes(selected.status)
          )
            setAnnouncement(`Migration ${selected.id} is now ${selected.status}.`);
        }
        return selected?.id ?? '';
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Unable to load migration jobs.');
    }
  }, [adapterId, fail, organizationId, version]);

  const loadEvents = React.useCallback(async () => {
    if (!selectedJobId) return;
    try {
      const result = await adminApi.listMigrationEvents(selectedJobId);
      if (!result.ok) {
        fail(result.error.message);
        return;
      }
      setMigrationEvents(result.data.items);
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Unable to load migration progress.');
    }
  }, [fail, selectedJobId]);

  React.useEffect(() => {
    void loadAdapters();
  }, [loadAdapters]);

  React.useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  React.useEffect(() => {
    const active = adapters.find((adapter) => adapter.id === adapterId);
    if (active && !active.supportedVersions.includes(version)) {
      setVersion(active.supportedVersions[0] || '');
    }
    if (active && !active.sourceModes.includes(sourceMode)) {
      setSourceMode(active.sourceModes[0] ?? 'official-export');
    }
  }, [adapterId, adapters, sourceMode, version]);

  React.useEffect(() => {
    setSelectedJobId('');
    setSelectedFile(null);
    setUploadedArtifactId('');
    setPreview(null);
    setPreviewError(null);
    setMappingError(null);
    setReport(null);
    setAssessment(null);
    setCommitConfirmation('');
    setRollbackConfirmation('');
    setMigrationEvents([]);
    setApiScope({
      organizerSlug: '',
      accountId: '',
      organizationId: '',
      eventIds: '',
      eventSlugs: '',
      baseUrl: '',
    });
    void loadJobs();
  }, [organizationId, adapterId, version, sourceMode, loadJobs]);

  React.useEffect(() => {
    if (!activeJob) return;
    let delay = 2_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      if (document.visibilityState !== 'visible') {
        timer = setTimeout(poll, 10_000);
        return;
      }
      await Promise.all([loadJobs(), loadEvents()]);
      delay = Math.min(delay * 2, 15_000);
      timer = setTimeout(poll, delay);
    };
    timer = setTimeout(poll, delay);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void Promise.all([loadJobs(), loadEvents()]);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [activeJob, loadEvents, loadJobs]);

  React.useEffect(() => {
    setAssessment(null);
    setCommitConfirmation('');
    setRollbackConfirmation('');
  }, [selectedJobId]);

  async function execute(
    label: string,
    action: () => Promise<ApiResult<unknown>>,
  ): Promise<boolean> {
    setBusy(true);
    setOperationError(null);
    setAnnouncement(`${label} in progress.`);
    try {
      const result = await action();
      if (result.ok) {
        setAnnouncement(messageOf(result));
        setAssessment(null);
        await loadJobs();
      } else {
        fail(result.error.message);
      }
      return result.ok;
    } catch (error) {
      const message = error instanceof Error ? error.message : `${label} failed.`;
      setOperationError(message);
      setAnnouncement(message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createJob() {
    if (!organizationId || !selectedAdapter || !version) return;
    let configuration: CreateAdminMigrationJobInput['configuration'];
    try {
      if (sourceMode === 'official-export') {
        if (!uploadedArtifactId) throw new Error('Upload and scan an official export first.');
        configuration = {
          sourceMode: 'official-export',
          sourceSystem: selectedAdapter.id,
          artifactIds: [uploadedArtifactId],
        };
      } else {
        if (selectedAdapter.id === 'pretix') {
          if (!apiScope.organizerSlug.trim() || sourceIdentifiers(apiScope.eventSlugs).length === 0)
            throw new Error('Organizer slug and at least one event slug are required.');
          configuration = {
            sourceMode: 'official-api',
            sourceSystem: 'pretix',
            organizerSlug: apiScope.organizerSlug.trim(),
            eventSlugs: sourceIdentifiers(apiScope.eventSlugs),
            ...(apiScope.baseUrl.trim() ? { baseUrl: apiScope.baseUrl.trim() } : {}),
          };
        } else if (selectedAdapter.id === 'hi-events') {
          if (!apiScope.accountId.trim() || sourceIdentifiers(apiScope.eventIds).length === 0)
            throw new Error('Account ID and at least one event ID are required.');
          configuration = {
            sourceMode: 'official-api',
            sourceSystem: 'hi-events',
            accountId: apiScope.accountId.trim(),
            eventIds: sourceIdentifiers(apiScope.eventIds),
            ...(apiScope.baseUrl.trim() ? { baseUrl: apiScope.baseUrl.trim() } : {}),
          };
        } else if (selectedAdapter.id === 'eventbrite') {
          if (!apiScope.organizationId.trim()) throw new Error('Organization ID is required.');
          const eventIds = sourceIdentifiers(apiScope.eventIds);
          configuration = {
            sourceMode: 'official-api',
            sourceSystem: 'eventbrite',
            organizationId: apiScope.organizationId.trim(),
            eventIds,
          };
        } else if (selectedAdapter.id === 'ticket-tailor') {
          if (!apiScope.accountId.trim() || sourceIdentifiers(apiScope.eventIds).length === 0)
            throw new Error('Account ID and at least one event ID are required.');
          configuration = {
            sourceMode: 'official-api',
            sourceSystem: 'ticket-tailor',
            accountId: apiScope.accountId.trim(),
            eventIds: sourceIdentifiers(apiScope.eventIds),
          };
        } else throw new Error('The selected importer does not support official API acquisition.');
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Invalid source configuration.');
      return;
    }
    setBusy(true);
    setOperationError(null);
    setAnnouncement('Creating migration job.');
    try {
      const input = {
        organizationId,
        sourceSystem: selectedAdapter.id,
        adapterVersion: version,
        mode: 'dry-run',
        configuration,
        ...(credentialId.trim() ? { credentialId: credentialId.trim() } : {}),
      } as CreateAdminMigrationJobInput;
      const result = await adminApi.createMigrationJob(input);
      if (result.ok) {
        setAnnouncement(messageOf(result));
        if (uploadedArtifactId) {
          const registration = await adminApi.registerMigrationFile(
            result.data.id,
            uploadedArtifactId,
          );
          if (!registration.ok) {
            fail(registration.error.message);
            return;
          }
        }
        await loadJobs();
        setSelectedJobId(result.data.id);
      } else {
        fail(result.error.message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to create migration job.';
      setOperationError(message);
      setAnnouncement(message);
    } finally {
      setBusy(false);
    }
  }

  async function selectCsv(file: File | null) {
    setSelectedFile(file);
    setPreview(null);
    setPreviewError(null);
    if (!file) return;
    try {
      assertGenericCsvByteSize(file.size);
      const content = await file.text();
      const result = previewGenericCsv({ documents: [{ name: file.name, content }] }, 5)[0];
      if (!result) throw new Error('CSV preview could not be generated.');
      setPreview(result);
      if (result.entityType) setMappingEntity(result.entityType);
      if (result.headers.length > 0) {
        setMappingText(
          jsonSummary(Object.fromEntries(result.headers.map((header) => [header, header]))),
        );
      }
      setAnnouncement(`Previewed ${file.name}; ${result.rows.length} sample rows loaded.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to read the selected CSV.';
      setPreviewError(message);
      fail(message);
    }
  }

  async function uploadAndRegister() {
    if (!selectedFile || !selectedAdapter) return;
    if (selectedJob && !selectedJobMatchesWorkspace) {
      fail('The selected job does not match this organization, importer, and version.');
      return;
    }
    setBusy(true);
    setOperationError(null);
    setAnnouncement('Uploading source file for malware scanning.');
    try {
      const upload = await adminApi.uploadArtifact({
        purpose: 'migration_import',
        file: selectedFile,
        metadata: {
          sourceSystem: selectedAdapter.id,
          ...(selectedJob ? { migrationJobId: selectedJob.id } : {}),
        },
      });
      if (!upload.ok) {
        fail(upload.error.message);
        return;
      }
      if (upload.data.scanStatus !== 'clean') {
        fail(`Upload scan status is ${upload.data.scanStatus}; registration is blocked.`);
        return;
      }
      setUploadedArtifactId(upload.data.artifactId);
      if (selectedJob) {
        const registration = await adminApi.registerMigrationFile(
          selectedJob.id,
          upload.data.artifactId,
        );
        setAnnouncement(messageOf(registration));
        if (registration.ok) await loadJobs();
        else fail(registration.error.message);
      } else {
        setAnnouncement('Clean export is ready; create the migration job to register it.');
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Unable to upload migration file.');
    } finally {
      setBusy(false);
    }
  }

  async function saveMapping() {
    if (!organizationId || !selectedAdapter) return;
    let mapping: Record<string, string | string[]>;
    try {
      const parsed: unknown = JSON.parse(mappingText);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('Mapping must be a JSON object.');
      }
      mapping = parsed as Record<string, string | string[]>;
      if (
        Object.keys(mapping).length === 0 ||
        Object.values(mapping).some(
          (value) =>
            !(
              (typeof value === 'string' && value.trim()) ||
              (Array.isArray(value) &&
                value.length > 0 &&
                value.every((item) => typeof item === 'string'))
            ),
        )
      ) {
        throw new Error('Every mapping field must have a source column or non-empty column list.');
      }
      setMappingError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mapping is invalid.';
      setMappingError(message);
      fail(message);
      return;
    }
    await execute('Save mapping', () =>
      adminApi.saveMigrationMapping({
        organizationId,
        sourceSystem: selectedAdapter.id,
        name: mappingName.trim(),
        entityType: mappingEntity,
        mapping,
      }),
    );
  }

  async function loadReport() {
    if (!selectedJob) return;
    setBusy(true);
    setOperationError(null);
    try {
      const result = await adminApi.getMigrationReport(selectedJob.id);
      setAnnouncement(messageOf(result));
      if (result.ok) setReport(result.data);
      else setOperationError(result.error.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load migration report.';
      setOperationError(message);
      setAnnouncement(message);
    } finally {
      setBusy(false);
    }
  }

  async function loadAssessment() {
    if (!selectedJob) return;
    setBusy(true);
    setOperationError(null);
    try {
      const result = await adminApi.getMigrationRollbackAssessment(selectedJob.id);
      setAnnouncement(messageOf(result));
      if (result.ok) setAssessment(result.data);
      else setOperationError(result.error.message);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to load rollback assessment.';
      setOperationError(message);
      setAnnouncement(message);
    } finally {
      setBusy(false);
    }
  }

  function downloadPreviewErrors() {
    if (!preview) return;
    const csv = createGenericCsvErrorExport(
      preview.issues.map((issue) => ({
        sourcePosition: issue.sourcePosition ?? preview.documentName,
        entityType: issue.entityType,
        externalId: issue.externalId,
        field: issue.field,
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
      })),
    );
    downloadText('migration-preview-errors.csv', csv, 'text/csv;charset=utf-8');
  }

  return (
    <div
      className="mx-auto w-full max-w-7xl space-y-6"
      aria-labelledby="migration-heading"
      aria-busy={busy}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 id="migration-heading" className="text-2xl font-bold tracking-tight">
            Migration workspace
          </h1>
          <p className="text-sm text-muted-foreground">
            Preview, validate, commit, and safely recover durable imports.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void loadJobs()}
          disabled={!organizationId || busy}
        >
          <RefreshCw aria-hidden="true" /> Refresh jobs
        </Button>
      </div>

      <output className="sr-only" aria-live="polite">
        {announcement}
      </output>
      <div className="rounded-md border bg-muted/40 px-4 py-3 text-sm" aria-hidden="true">
        {busy ? <LoaderCircle className="mr-2 inline size-4 animate-spin" /> : null}
        {announcement}
      </div>
      {operationError ? (
        <p
          role="alert"
          className="flex gap-2 rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          <AlertCircle aria-hidden="true" className="size-4" /> {operationError}
        </p>
      ) : null}

      <section className="grid gap-6 lg:grid-cols-2" aria-label="Migration setup">
        <Card>
          <CardHeader>
            <CardTitle>1. Source and workspace</CardTitle>
            <CardDescription>Select the exact official adapter and source version.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="migration-organization">Organization</Label>
              <Select
                value={organizationId ?? ''}
                onValueChange={setOrganizationId}
                disabled={contextLoading}
              >
                <SelectTrigger id="migration-organization">
                  <SelectValue placeholder="Select an organization" />
                </SelectTrigger>
                <SelectContent>
                  {organizations.map((organization) => (
                    <SelectItem key={organization.id} value={organization.id}>
                      {organization.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="migration-adapter">Importer</Label>
                <Select value={adapterId} onValueChange={setAdapterId}>
                  <SelectTrigger id="migration-adapter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {adapters.map((adapter) => (
                      <SelectItem key={adapter.id} value={adapter.id}>
                        {adapter.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="migration-version">Source version</Label>
                <Select value={version} onValueChange={setVersion}>
                  <SelectTrigger id="migration-version">
                    <SelectValue placeholder="Select version" />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedAdapter?.supportedVersions.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {selectedAdapter ? (
              <div className="space-y-3 rounded-md border p-3 text-sm">
                <div>
                  <span className="font-medium">Supported acquisition:</span>{' '}
                  {selectedAdapter.sourceModes.join(', ')}
                </div>
                <div>
                  <span className="font-medium">Rate limits:</span>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs">
                    {jsonSummary(selectedAdapter.rateLimitPolicy)}
                  </pre>
                </div>
                <div>
                  <span className="font-medium">Known loss:</span>
                  <ul className="list-disc pl-5">
                    {selectedAdapter.knownLosses.map((loss) => (
                      <li key={loss}>{loss}</li>
                    ))}
                  </ul>
                </div>
                <details>
                  <summary className="cursor-pointer font-medium">Feature mapping</summary>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs">
                    {jsonSummary(selectedAdapter.featureMapping)}
                  </pre>
                </details>
              </div>
            ) : null}
            {selectedAdapter && selectedAdapter.sourceModes.length > 1 ? (
              <div className="space-y-2">
                <Label htmlFor="migration-source-mode">Acquisition mode</Label>
                <Select
                  value={sourceMode}
                  onValueChange={(value) =>
                    setSourceMode(value as 'official-api' | 'official-export')
                  }
                >
                  <SelectTrigger id="migration-source-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedAdapter.sourceModes.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {mode}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {sourceMode === 'official-api' ? (
              <div className="space-y-3">
                {adapterId === 'pretix' ? (
                  <>
                    <Label htmlFor="migration-organizer-slug">Organizer slug</Label>
                    <Input
                      id="migration-organizer-slug"
                      value={apiScope.organizerSlug}
                      onChange={(event) =>
                        setApiScope((scope) => ({
                          ...scope,
                          organizerSlug: event.target.value,
                        }))
                      }
                    />
                    <Label htmlFor="migration-event-slugs">
                      Event slugs (comma or line separated)
                    </Label>
                    <Textarea
                      id="migration-event-slugs"
                      value={apiScope.eventSlugs}
                      onChange={(event) =>
                        setApiScope((scope) => ({
                          ...scope,
                          eventSlugs: event.target.value,
                        }))
                      }
                    />
                    <Label htmlFor="migration-base-url">
                      Pretix API origin (optional self-hosted HTTPS origin)
                    </Label>
                    <Input
                      id="migration-base-url"
                      type="url"
                      value={apiScope.baseUrl}
                      onChange={(event) =>
                        setApiScope((scope) => ({
                          ...scope,
                          baseUrl: event.target.value,
                        }))
                      }
                      placeholder="https://pretix.example.com"
                    />
                  </>
                ) : null}
                {adapterId === 'hi-events' ? (
                  <>
                    <Label htmlFor="migration-account-id">Account ID</Label>
                    <Input
                      id="migration-account-id"
                      value={apiScope.accountId}
                      onChange={(event) =>
                        setApiScope((scope) => ({
                          ...scope,
                          accountId: event.target.value,
                        }))
                      }
                    />
                    <Label htmlFor="migration-event-ids">Event IDs (comma or line separated)</Label>
                    <Textarea
                      id="migration-event-ids"
                      value={apiScope.eventIds}
                      onChange={(event) =>
                        setApiScope((scope) => ({
                          ...scope,
                          eventIds: event.target.value,
                        }))
                      }
                    />
                    <Label htmlFor="migration-base-url">
                      Hi.Events API origin (optional self-hosted HTTPS origin)
                    </Label>
                    <Input
                      id="migration-base-url"
                      type="url"
                      value={apiScope.baseUrl}
                      onChange={(event) =>
                        setApiScope((scope) => ({
                          ...scope,
                          baseUrl: event.target.value,
                        }))
                      }
                      placeholder="https://tickets.example.com"
                    />
                  </>
                ) : null}
                {adapterId === 'eventbrite' ? (
                  <>
                    <Label htmlFor="migration-source-organization-id">
                      Eventbrite organization ID
                    </Label>
                    <Input
                      id="migration-source-organization-id"
                      value={apiScope.organizationId}
                      onChange={(event) =>
                        setApiScope((scope) => ({
                          ...scope,
                          organizationId: event.target.value,
                        }))
                      }
                    />
                    <Label htmlFor="migration-event-ids">
                      Event IDs (optional; blank discovers organization events)
                    </Label>
                    <Textarea
                      id="migration-event-ids"
                      value={apiScope.eventIds}
                      onChange={(event) =>
                        setApiScope((scope) => ({
                          ...scope,
                          eventIds: event.target.value,
                        }))
                      }
                    />
                  </>
                ) : null}
                {adapterId === 'ticket-tailor' ? (
                  <>
                    <Label htmlFor="migration-account-id">Ticket Tailor account ID</Label>
                    <Input
                      id="migration-account-id"
                      value={apiScope.accountId}
                      onChange={(event) =>
                        setApiScope((scope) => ({
                          ...scope,
                          accountId: event.target.value,
                        }))
                      }
                    />
                    <Label htmlFor="migration-event-ids">Event IDs (comma or line separated)</Label>
                    <Textarea
                      id="migration-event-ids"
                      value={apiScope.eventIds}
                      onChange={(event) =>
                        setApiScope((scope) => ({
                          ...scope,
                          eventIds: event.target.value,
                        }))
                      }
                    />
                  </>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Only source identifiers are stored here. Tokens, cursors, records, query strings,
                  and arbitrary endpoint URLs are rejected.
                </p>
                <Label htmlFor="migration-credential">Credential reference ID (required)</Label>
                <Input
                  id="migration-credential"
                  value={credentialId}
                  onChange={(event) => setCredentialId(event.target.value)}
                  placeholder="mcred_…"
                />
                <p className="text-xs text-muted-foreground">
                  Create expiring credentials through the secret-reference API. Never paste API
                  tokens into job configuration.
                </p>
              </div>
            ) : null}
            <Button
              type="button"
              onClick={() => void createJob()}
              disabled={
                !canWrite ||
                !organizationId ||
                !selectedAdapter ||
                !version ||
                (sourceMode === 'official-api' && !credentialId.trim()) ||
                (sourceMode === 'official-export' && !uploadedArtifactId) ||
                busy
              }
            >
              Create dry-run job
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Job</CardTitle>
            <CardDescription>
              Select a job to upload files and run lifecycle actions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="migration-job">Migration job</Label>
              <Select
                value={selectedJobId}
                onValueChange={setSelectedJobId}
                disabled={!organizationId}
              >
                <SelectTrigger id="migration-job">
                  <SelectValue placeholder="No migration jobs" />
                </SelectTrigger>
                <SelectContent>
                  {jobs.map((job) => (
                    <SelectItem key={job.id} value={job.id}>
                      {job.source_system} · {job.status} · {job.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selectedJob ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
                <dt className="font-medium">Status</dt>
                <dd>
                  <Badge variant="outline">{selectedJob.status}</Badge>
                </dd>
                <dt className="font-medium">Mode</dt>
                <dd>{selectedJob.mode}</dd>
                <dt className="font-medium">Updated</dt>
                <dd>{new Date(selectedJob.updated_at).toLocaleString()}</dd>
                <dt className="font-medium">Configuration</dt>
                <dd className="truncate font-mono text-xs" title={selectedJob.configurationHash}>
                  {selectedJob.configurationHash}
                </dd>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                Create or select a job before registering source artifacts.
              </p>
            )}
            {selectedJob && !selectedJobMatchesWorkspace ? (
              <p role="alert" className="text-sm text-destructive">
                This job does not match the selected organization, importer, and source version.
                Select a matching job before running an action.
              </p>
            ) : null}
            {selectedJobMatchesWorkspace && lastMigrationEvent ? (
              <div className="rounded-md border p-3" aria-live="polite">
                <p className="text-sm font-medium">Latest progress</p>
                <p className="text-sm">{migrationEventSummary(lastMigrationEvent)}</p>
                {lastFailure ? (
                  <div className="mt-2 space-y-2">
                    <p className="text-sm text-destructive">
                      Latest failure or recovery: {migrationEventSummary(lastFailure)}
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void Promise.all([loadJobs(), loadEvents()])}
                    >
                      Refresh migration status
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </section>

      <section
        className="grid gap-6 lg:grid-cols-2"
        aria-label={genericCsv ? 'Generic CSV preparation' : 'Official export preparation'}
      >
        <Card>
          <CardHeader>
            <CardTitle>3. {genericCsv ? 'Generic CSV' : 'Official export'}</CardTitle>
            <CardDescription>
              Download a template or inspect an official export locally before upload.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {genericCsv ? (
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <div className="space-y-2">
                  <Label htmlFor="csv-entity">Template entity</Label>
                  <Select
                    value={mappingEntity}
                    onValueChange={(value) => setMappingEntity(value as GenericCsvEntityType)}
                  >
                    <SelectTrigger id="csv-entity">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GENERIC_CSV_ENTITY_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {type}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  className="self-end"
                  type="button"
                  variant="outline"
                  onClick={() =>
                    downloadText(
                      `${mappingEntity}.csv`,
                      createGenericCsvTemplate(mappingEntity),
                      'text/csv;charset=utf-8',
                    )
                  }
                >
                  <Download aria-hidden="true" /> Template
                </Button>
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="migration-file">
                {genericCsv
                  ? 'Official CSV export'
                  : `${selectedAdapter?.displayName ?? 'Official'} export archive`}
              </Label>
              <Input
                id="migration-file"
                type="file"
                accept={
                  genericCsv
                    ? '.csv,text/csv'
                    : '.zip,.json,.jsonl,.ndjson,.xml,.tar,.gz,application/zip,application/json,application/xml,application/gzip'
                }
                onChange={(event) =>
                  genericCsv
                    ? void selectCsv(event.target.files?.[0] ?? null)
                    : (setSelectedFile(event.target.files?.[0] ?? null),
                      setPreview(null),
                      setPreviewError(null))
                }
              />
            </div>
            {genericCsv && previewError ? (
              <p className="flex gap-2 text-sm text-destructive">
                <AlertCircle aria-hidden="true" className="size-4" />
                {previewError}
              </p>
            ) : null}
            {genericCsv && preview ? (
              <div className="space-y-2">
                <p className="text-sm">
                  <span className="font-medium">Detected:</span> {preview.entityType ?? 'unknown'} ·
                  delimiter <code>{JSON.stringify(preview.delimiter)}</code> · {preview.rows.length}{' '}
                  preview rows
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-max border-collapse text-left text-xs">
                    <caption className="sr-only">Local CSV preview</caption>
                    <thead>
                      <tr>
                        {preview.headers.map((header) => (
                          <th key={header} className="border p-2">
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row, index) => (
                        <tr key={index}>
                          {preview.headers.map((header) => (
                            <td key={header} className="max-w-48 truncate border p-2">
                              {row[header]}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {preview.issues.length > 0 ? (
                  <Button type="button" variant="outline" onClick={downloadPreviewErrors}>
                    Download preview errors
                  </Button>
                ) : null}
              </div>
            ) : null}
            <Button
              type="button"
              onClick={() => void uploadAndRegister()}
              disabled={!canWrite || !selectedFile || !selectedAdapter || !organizationId || busy}
            >
              <FileUp aria-hidden="true" /> Upload and scan official export
            </Button>
            <p className="text-xs text-muted-foreground">
              Files are first uploaded with purpose <code>migration_import</code>. Registration
              occurs only after the upload service reports a clean malware scan; the browser never
              supplies object-store keys or hashes.
            </p>
          </CardContent>
        </Card>

        {genericCsv ? (
          <Card>
            <CardHeader>
              <CardTitle>4. Mapping profile</CardTitle>
              <CardDescription>
                Edit a source-column mapping. JSON is validated before it is saved.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="mapping-name">Profile name</Label>
                <Input
                  id="mapping-name"
                  value={mappingName}
                  onChange={(event) => setMappingName(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mapping-json">Field mapping JSON</Label>
                <Textarea
                  id="mapping-json"
                  className="min-h-56 font-mono text-xs"
                  value={mappingText}
                  onChange={(event) => {
                    setMappingText(event.target.value);
                    setMappingError(null);
                  }}
                  aria-describedby="mapping-help mapping-error"
                  aria-invalid={Boolean(mappingError)}
                />
                <p id="mapping-help" className="text-xs text-muted-foreground">
                  Keys are destination fields; values are source CSV columns. Arrays may combine
                  source columns.
                </p>
                {mappingError ? (
                  <p id="mapping-error" className="text-sm text-destructive">
                    {mappingError}
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                onClick={() => void saveMapping()}
                disabled={!canWrite || !organizationId || !mappingName.trim() || busy}
              >
                Validate and save profile
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>4. Source mapping</CardTitle>
              <CardDescription>
                {selectedAdapter?.displayName} exports use the versioned adapter mapping. Review the
                feature mapping and known-loss report above before preparing.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>5. Validate and control</CardTitle>
          <CardDescription>
            Prepare acquires and normalizes the registered official source. Dry runs write no domain
            entities. Commit and rollback require exact, user-entered confirmation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                selectedJob &&
                void execute('Prepare', () => adminApi.prepareMigration(selectedJob.id))
              }
              disabled={
                !canWrite ||
                !selectedJobMatchesWorkspace ||
                !['pending', 'ready', 'failed'].includes(selectedJob?.status ?? '') ||
                busy
              }
            >
              Prepare source
            </Button>
            <Button
              type="button"
              onClick={() =>
                selectedJob &&
                void execute('Dry run', () => adminApi.runMigrationDryRun(selectedJob.id))
              }
              disabled={
                !canWrite || !selectedJobMatchesWorkspace || selectedJob?.status !== 'ready' || busy
              }
            >
              Run dry-run
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadReport()}
              disabled={!selectedJobMatchesWorkspace || busy}
            >
              Load report
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                selectedJob &&
                void execute('Pause', () => adminApi.controlMigration(selectedJob.id, 'pause'))
              }
              disabled={
                !canWrite ||
                !selectedJobMatchesWorkspace ||
                !['preparing', 'running'].includes(selectedJob?.status ?? '') ||
                busy
              }
            >
              Pause
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                selectedJob &&
                void execute('Resume', () => adminApi.controlMigration(selectedJob.id, 'resume'))
              }
              disabled={
                !canWrite ||
                !selectedJobMatchesWorkspace ||
                selectedJob?.status !== 'paused' ||
                busy
              }
            >
              Resume
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                selectedJob &&
                void execute('Cancel', () => adminApi.controlMigration(selectedJob.id, 'cancel'))
              }
              disabled={
                !canWrite ||
                !selectedJobMatchesWorkspace ||
                !['ready', 'preparing', 'running', 'paused', 'failed'].includes(
                  selectedJob?.status ?? '',
                ) ||
                busy
              }
            >
              Cancel
            </Button>
          </div>
          {report ? (
            <div className="rounded-md border p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">Dry-run report</h3>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    downloadText(
                      `migration-${selectedJobId}-report.json`,
                      jsonSummary(report),
                      'application/json',
                    )
                  }
                >
                  Download JSON
                </Button>
              </div>
              <dl className="mb-3 grid gap-2 sm:grid-cols-2" aria-label="Dry-run report summary">
                {reportCounts(report).map(([label, count]) => (
                  <div key={label} className="rounded border p-2">
                    <dt className="text-xs text-muted-foreground">{label.replaceAll('_', ' ')}</dt>
                    <dd className="text-lg font-semibold">{count.toLocaleString()}</dd>
                  </div>
                ))}
              </dl>
              {reportSeverityCounts(report).length > 0 ? (
                <dl className="mb-3 flex flex-wrap gap-2" aria-label="Issue severity summary">
                  {reportSeverityCounts(report).map(([label, count]) => (
                    <div key={label} className="rounded border px-3 py-2">
                      <dt className="text-xs capitalize">{label}</dt>
                      <dd className="font-semibold">{count.toLocaleString()}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {(['severity', 'issues', 'unsupported', 'conflicts', 'correctivePlans'] as const).map(
                (key) => {
                  const items = reportList(report, key);
                  if (items.length === 0) return null;
                  return (
                    <section key={key} className="mb-3" aria-labelledby={`report-${key}`}>
                      <h4 id={`report-${key}`} className="font-medium">
                        {key.replaceAll(/([A-Z])/gu, ' $1')}
                      </h4>
                      <ul className="list-disc pl-5 text-sm">
                        {items.slice(0, 10).map((item, index) => (
                          <li key={index}>
                            {typeof item === 'string'
                              ? item
                              : String(
                                  recordValue(item).message ??
                                    recordValue(item).code ??
                                    'See technical details',
                                )}
                          </li>
                        ))}
                      </ul>
                      {items.length > 10 ? (
                        <p className="text-xs text-muted-foreground">
                          {items.length - 10} more in the downloadable report.
                        </p>
                      ) : null}
                    </section>
                  );
                },
              )}
              <details>
                <summary className="cursor-pointer font-medium">Technical report details</summary>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">
                  {jsonSummary(report)}
                </pre>
              </details>
            </div>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-2">
            <fieldset className="space-y-2 rounded-md border p-4">
              <legend className="px-1 font-semibold">Commit</legend>
              <Label htmlFor="commit-confirmation">
                Type <code>commit:{selectedJobId || '<job-id>'}</code>
              </Label>
              <Input
                id="commit-confirmation"
                value={commitConfirmation}
                onChange={(event) => setCommitConfirmation(event.target.value)}
                autoComplete="off"
              />
              <Button
                type="button"
                onClick={() =>
                  selectedJob &&
                  void execute('Commit', () =>
                    adminApi.commitMigration(
                      selectedJob.id,
                      commitConfirmation as `commit:${string}`,
                    ),
                  )
                }
                disabled={
                  !canCommit ||
                  !selectedJobMatchesWorkspace ||
                  !['ready', 'validated'].includes(selectedJob?.status ?? '') ||
                  commitConfirmation !== `commit:${selectedJob?.id}` ||
                  busy
                }
              >
                Commit migration
              </Button>
            </fieldset>
            <fieldset className="space-y-2 rounded-md border p-4">
              <legend className="px-1 font-semibold">Rollback assessment</legend>
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadAssessment()}
                disabled={!selectedJob || busy}
              >
                Refresh live assessment
              </Button>
              {assessment ? (
                <div>
                  <p className="text-sm font-medium">
                    Rollback is {rollbackEligible(assessment) ? 'eligible' : 'not eligible'}.
                  </p>
                  <details>
                    <summary className="cursor-pointer text-sm">
                      Technical assessment details
                    </summary>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">
                      {jsonSummary(assessment)}
                    </pre>
                  </details>
                </div>
              ) : null}
              <Label htmlFor="rollback-confirmation">
                Type <code>rollback:{selectedJobId || '<job-id>'}</code>
              </Label>
              <Input
                id="rollback-confirmation"
                value={rollbackConfirmation}
                onChange={(event) => setRollbackConfirmation(event.target.value)}
                autoComplete="off"
              />
              <Button
                type="button"
                variant="destructive"
                onClick={() =>
                  selectedJob &&
                  void execute('Rollback', () =>
                    adminApi.rollbackMigration(
                      selectedJob.id,
                      rollbackConfirmation as `rollback:${string}`,
                    ),
                  )
                }
                disabled={
                  !canRollback ||
                  !rollbackEligible(assessment) ||
                  !selectedJobMatchesWorkspace ||
                  rollbackConfirmation !== `rollback:${selectedJob?.id}` ||
                  busy
                }
              >
                Rollback eligible entities
              </Button>
              <p className="text-xs text-muted-foreground">
                The server repeats the authoritative activity check and refuses destructive rollback
                after sales, scans, transfers, edits, provider events, or downstream references.
              </p>
            </fieldset>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
