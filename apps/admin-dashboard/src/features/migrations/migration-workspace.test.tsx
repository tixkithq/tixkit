import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERIC_CSV_LIMITS } from '@tixkit/migration-core/generic-csv';
import { MigrationWorkspace } from './migration-workspace';

const api = vi.hoisted(() => ({
  listMigrationAdapters: vi.fn(),
  listMigrationJobs: vi.fn(),
  createMigrationJob: vi.fn(),
  uploadArtifact: vi.fn(),
  registerMigrationFile: vi.fn(),
  saveMigrationMapping: vi.fn(),
  getMigrationReport: vi.fn(),
  getMigrationRollbackAssessment: vi.fn(),
  runMigrationDryRun: vi.fn(),
  controlMigration: vi.fn(),
  commitMigration: vi.fn(),
  rollbackMigration: vi.fn(),
  listMigrationEvents: vi.fn(),
}));
const permissions = vi.hoisted(() => ({ allowed: true }));

vi.mock('@/lib/api', () => ({ adminApi: api }));
vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => ({
    organizations: [{ id: 'org_1', name: 'Acme Events' }],
    organizationId: 'org_1',
    setOrganizationId: vi.fn(),
    loading: false,
  }),
}));
vi.mock('@/context/permission-provider', () => ({
  usePermissions: () => ({ can: () => permissions.allowed }),
}));

const adapter = {
  id: 'generic-csv' as const,
  displayName: 'Generic CSV',
  supportedVersions: ['rfc4180-v1'],
  featureMapping: { event: ['events'] },
  knownLosses: ['Reserved seating is not represented.'],
  rateLimitPolicy: { strategy: 'local file' },
  sourceModes: ['official-export' as const],
};

const job = {
  id: 'job_1',
  organization_id: 'org_1',
  source_system: 'generic-csv',
  adapter_version: 'rfc4180-v1',
  mode: 'dry-run' as const,
  status: 'ready',
  configurationHash: 'sha256:abc',
  credentialConfigured: false,
  summary: null,
  created_at: '2026-07-10T00:00:00.000Z',
  updated_at: '2026-07-10T00:00:00.000Z',
};

describe('MigrationWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissions.allowed = true;
    api.listMigrationAdapters.mockResolvedValue({
      ok: true,
      data: { items: [adapter] },
    });
    api.listMigrationJobs.mockResolvedValue({
      ok: true,
      data: { items: [job] },
    });
    api.saveMigrationMapping.mockResolvedValue({
      ok: true,
      data: { id: 'mapping_1' },
    });
    api.getMigrationRollbackAssessment.mockResolvedValue({
      ok: true,
      data: { eligible: true, mode: 'delete-untouched-before-activation' },
    });
    api.commitMigration.mockResolvedValue({
      ok: true,
      data: { status: 'committing' },
    });
    api.rollbackMigration.mockResolvedValue({
      ok: true,
      data: { status: 'rolling-back' },
    });
    api.uploadArtifact.mockResolvedValue({
      ok: true,
      data: { artifactId: 'upload_1', status: 'complete', scanStatus: 'clean' },
    });
    api.registerMigrationFile.mockResolvedValue({
      ok: true,
      data: { id: 'file_1' },
    });
    api.createMigrationJob.mockResolvedValue({ ok: true, data: job });
    api.listMigrationEvents.mockResolvedValue({ ok: true, data: { items: [] } });
  });

  it('renders importer safety metadata and accessible lifecycle controls', async () => {
    render(<MigrationWorkspace />);

    expect(await screen.findByText('Reserved seating is not represented.')).toBeInTheDocument();
    expect(screen.getByLabelText('Organization')).toBeInTheDocument();
    expect(screen.getByLabelText('Official CSV export')).toHaveAttribute('accept', '.csv,text/csv');
    expect(screen.getByRole('button', { name: 'Commit migration' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rollback eligible entities' })).toBeDisabled();
  });

  it('validates mapping JSON before calling the save API', async () => {
    render(<MigrationWorkspace />);
    await screen.findByText('Reserved seating is not represented.');

    fireEvent.change(screen.getByLabelText('Field mapping JSON'), {
      target: { value: '[]' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Validate and save profile' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Mapping must be a JSON object.');
    expect(api.saveMigrationMapping).not.toHaveBeenCalled();
  });

  it('previews a CSV locally then uploads and registers only its clean artifact ID', async () => {
    render(<MigrationWorkspace />);
    await screen.findByText('Reserved seating is not represented.');
    const file = new File(['external_id,name\nevent_1,Launch'], 'events.csv', {
      type: 'text/csv',
    });
    Object.defineProperty(file, 'text', {
      value: async () => 'external_id,name\nevent_1,Launch',
    });

    fireEvent.change(screen.getByLabelText('Official CSV export'), {
      target: { files: [file] },
    });
    expect(await screen.findByText(/delimiter/)).toHaveTextContent(/Detected:\s*event/);
    fireEvent.click(screen.getByRole('button', { name: 'Upload and scan official export' }));

    await waitFor(() =>
      expect(api.uploadArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: 'migration_import', file }),
      ),
    );
    expect(api.registerMigrationFile).toHaveBeenCalledWith('job_1', 'upload_1');
  });

  it('rejects an oversized CSV before reading it into browser memory', async () => {
    render(<MigrationWorkspace />);
    await screen.findByText('Reserved seating is not represented.');
    const text = vi.fn(async () => 'external_id,name\nevent_1,Launch');
    const file = new File(['x'], 'oversized.csv', { type: 'text/csv' });
    Object.defineProperties(file, {
      size: { value: GENERIC_CSV_LIMITS.maxBytes + 1 },
      text: { value: text },
    });

    fireEvent.change(screen.getByLabelText('Official CSV export'), {
      target: { files: [file] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/byte limit/u);
    expect(text).not.toHaveBeenCalled();
  });

  it('requires exact typed confirmations and an eligible live assessment', async () => {
    render(<MigrationWorkspace />);
    await screen.findByText('Reserved seating is not represented.');
    await waitFor(() => expect(screen.getByLabelText('Migration job')).toHaveTextContent('job_1'));

    fireEvent.change(screen.getByLabelText(/Type commit:job_1/), {
      target: { value: 'commit:wrong' },
    });
    expect(screen.getByRole('button', { name: 'Commit migration' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type commit:job_1/), {
      target: { value: 'commit:job_1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Commit migration' }));
    await waitFor(() => expect(api.commitMigration).toHaveBeenCalledWith('job_1', 'commit:job_1'));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh live assessment' }));
    await waitFor(() => expect(api.getMigrationRollbackAssessment).toHaveBeenCalledWith('job_1'));
    fireEvent.change(screen.getByLabelText(/Type rollback:job_1/), {
      target: { value: 'rollback:job_1' },
    });
    expect(screen.getByRole('button', { name: 'Rollback eligible entities' })).toBeEnabled();
  });

  it('keeps an actionable alert and clears busy state after an async failure', async () => {
    api.getMigrationReport.mockRejectedValue(new Error('Report service unavailable'));
    render(<MigrationWorkspace />);
    await waitFor(() => expect(screen.getByLabelText('Migration job')).toHaveTextContent('job_1'));

    fireEvent.click(screen.getByRole('button', { name: 'Load report' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Report service unavailable');
    expect(
      screen.getByRole('heading', { name: 'Migration workspace' }).closest('[aria-busy]'),
    ).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('button', { name: 'Load report' })).toBeEnabled();
  });

  it('surfaces non-OK lifecycle actions in the persistent alert', async () => {
    api.runMigrationDryRun.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_READY', message: 'Prepare the source first' },
    });
    render(<MigrationWorkspace />);
    await waitFor(() => expect(screen.getByLabelText('Migration job')).toHaveTextContent('job_1'));
    fireEvent.click(screen.getByRole('button', { name: 'Run dry-run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Prepare the source first');
  });

  it('surfaces a non-OK create-time file registration in the persistent alert', async () => {
    api.listMigrationJobs.mockResolvedValue({ ok: true, data: { items: [] } });
    api.registerMigrationFile.mockResolvedValue({
      ok: false,
      error: { code: 'FILE_REJECTED', message: 'The scanned file could not be registered' },
    });
    render(<MigrationWorkspace />);
    const file = new File(['external_id,name\nevent_1,Launch'], 'events.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => 'external_id,name\nevent_1,Launch' });
    fireEvent.change(await screen.findByLabelText('Official CSV export'), {
      target: { files: [file] },
    });
    await screen.findByText(/delimiter/);
    fireEvent.click(screen.getByRole('button', { name: 'Upload and scan official export' }));
    await waitFor(() => expect(api.uploadArtifact).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Create dry-run job' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The scanned file could not be registered',
    );
  });

  it('renders nested report counts, severity, issues, losses, conflicts, and corrective plans', async () => {
    api.getMigrationReport.mockResolvedValue({
      ok: true,
      data: {
        job: { id: 'job_1', status: 'ready' },
        report: {
          counts: { create: 12, skip: 3 },
          severityCounts: { fatal: 0, warning: 2 },
          issues: [{ code: 'TIMEZONE', message: 'Timezone needs review' }],
          unsupportedFeatures: ['Reserved seating'],
        },
        conflicts: [{ code: 'DUPLICATE' }],
        correctivePlans: ['Resolve duplicates and rerun'],
      },
    });
    render(<MigrationWorkspace />);
    await waitFor(() => expect(screen.getByLabelText('Migration job')).toHaveTextContent('job_1'));
    fireEvent.click(screen.getByRole('button', { name: 'Load report' }));
    expect(await screen.findByText('Timezone needs review')).toBeInTheDocument();
    expect(screen.getByText('Reserved seating')).toBeInTheDocument();
    expect(screen.getByText('DUPLICATE')).toBeInTheDocument();
    expect(screen.getByText('Resolve duplicates and rerun')).toBeInTheDocument();
    expect(screen.getByLabelText('Dry-run report summary')).toHaveTextContent('12');
    expect(screen.getByLabelText('Issue severity summary')).toHaveTextContent('warning2');
  });

  it('accepts an official non-CSV export without attempting a CSV preview', async () => {
    const pretix = {
      ...adapter,
      id: 'pretix' as const,
      displayName: 'pretix',
      supportedVersions: ['2026.1'],
      sourceModes: ['official-export' as const],
    };
    api.listMigrationAdapters.mockResolvedValue({
      ok: true,
      data: { items: [pretix] },
    });
    api.listMigrationJobs.mockResolvedValue({ ok: true, data: { items: [] } });
    render(<MigrationWorkspace />);

    const input = await screen.findByLabelText('pretix export archive');
    expect(input).toHaveAttribute('accept', expect.stringContaining('.zip'));
    expect(screen.queryByText('Template entity')).not.toBeInTheDocument();
    const file = new File(['archive'], 'pretix-export.zip', {
      type: 'application/zip',
    });
    const text = vi.fn(async () => 'not csv');
    Object.defineProperty(file, 'text', { value: text });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload and scan official export' }));
    await waitFor(() =>
      expect(api.uploadArtifact).toHaveBeenCalledWith(expect.objectContaining({ file })),
    );
    expect(text).not.toHaveBeenCalled();
  });

  it.each([
    [
      'pretix',
      {
        organizerSlug: 'organizer',
        eventSlugs: ['event-one'],
        baseUrl: 'https://pretix.example.com',
      },
    ],
    [
      'hi-events',
      {
        accountId: 'account-1',
        eventIds: ['event-1'],
        baseUrl: 'https://events.example.com',
      },
    ],
    ['eventbrite', { organizationId: 'organization-1', eventIds: ['event-1'] }],
    ['ticket-tailor', { accountId: 'account-1', eventIds: ['event-1'] }],
  ] as const)('builds labeled %s API configuration without raw JSON', async (id, expected) => {
    const apiAdapter = {
      ...adapter,
      id,
      displayName: id,
      supportedVersions: ['v1'],
      sourceModes: ['official-api' as const],
    };
    api.listMigrationAdapters.mockResolvedValue({
      ok: true,
      data: { items: [apiAdapter] },
    });
    api.listMigrationJobs.mockResolvedValue({
      ok: true,
      data: { items: [] },
    });
    render(<MigrationWorkspace />);

    await screen
      .findByText(id, { selector: '[role="option"], button, span' })
      .catch(() => undefined);
    if (id === 'pretix') {
      fireEvent.change(await screen.findByLabelText('Organizer slug'), {
        target: { value: 'organizer' },
      });
      fireEvent.change(screen.getByLabelText('Event slugs (comma or line separated)'), {
        target: { value: 'event-one' },
      });
      fireEvent.change(screen.getByLabelText(/Pretix API origin/), {
        target: { value: 'https://pretix.example.com' },
      });
    } else {
      fireEvent.change(
        await screen.findByLabelText(
          id === 'eventbrite'
            ? 'Eventbrite organization ID'
            : id === 'ticket-tailor'
              ? 'Ticket Tailor account ID'
              : 'Account ID',
        ),
        {
          target: {
            value: id === 'eventbrite' ? 'organization-1' : 'account-1',
          },
        },
      );
      fireEvent.change(screen.getByLabelText(/Event IDs/), {
        target: { value: 'event-1' },
      });
      if (id === 'hi-events')
        fireEvent.change(screen.getByLabelText(/Hi.Events API origin/), {
          target: { value: 'https://events.example.com' },
        });
    }
    fireEvent.change(screen.getByLabelText('Credential reference ID (required)'), {
      target: { value: 'mcred_12345678' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create dry-run job' }));
    await waitFor(() =>
      expect(api.createMigrationJob).toHaveBeenCalledWith(
        expect.objectContaining({
          configuration: expect.objectContaining(expected),
        }),
      ),
    );
    expect(screen.queryByLabelText('Official API scope configuration')).not.toBeInTheDocument();
  });

  it.each([
    ['organization', { ...job, organization_id: 'org_other' }],
    ['source', { ...job, source_system: 'pretix' }],
    ['version', { ...job, adapter_version: 'old-version' }],
  ])('never auto-selects or registers a %s-mismatched job', async (_kind, mismatchedJob) => {
    api.listMigrationJobs.mockResolvedValue({ ok: true, data: { items: [mismatchedJob] } });
    render(<MigrationWorkspace />);
    await screen.findByText('Reserved seating is not represented.');
    expect(screen.getByLabelText('Migration job')).toHaveTextContent('No migration jobs');
    const file = new File(['external_id,name\nevent_1,Launch'], 'events.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => 'external_id,name\nevent_1,Launch' });
    fireEvent.change(screen.getByLabelText('Official CSV export'), { target: { files: [file] } });
    await screen.findByText(/delimiter/);
    fireEvent.click(screen.getByRole('button', { name: 'Upload and scan official export' }));
    await waitFor(() => expect(api.uploadArtifact).toHaveBeenCalled());
    expect(api.registerMigrationFile).not.toHaveBeenCalled();
  });

  it('polls progress and announces a terminal status transition', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const runningJob = { ...job, status: 'running' };
    api.listMigrationJobs.mockResolvedValue({ ok: true, data: { items: [runningJob] } });
    api.listMigrationEvents.mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            type: 'source.recoverable-error',
            severity: 'error',
            message: 'The source API is temporarily unavailable',
            data: { errorCode: 'SOURCE_UNAVAILABLE' },
          },
          {
            type: 'rows.progress',
            severity: 'info',
            message: 'Import rows are processing',
            data: { processed: 25, total: 100, checkpoint: 'page-2' },
          },
        ],
      },
    });
    render(<MigrationWorkspace />);
    await waitFor(() => expect(screen.getByLabelText('Migration job')).toHaveTextContent('job_1'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(
      await screen.findByText(
        /source.recoverable-error.*SOURCE_UNAVAILABLE.*temporarily unavailable/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/rows.progress: 25 of 100 rows.*checkpoint page-2/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh migration status' })).toBeEnabled();
    api.listMigrationJobs.mockResolvedValue({
      ok: true,
      data: { items: [{ ...runningJob, status: 'completed' }] },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
    });
    expect(screen.getAllByText('Migration job_1 is now completed.').length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('keeps write controls unavailable without migration permissions', async () => {
    permissions.allowed = false;
    render(<MigrationWorkspace />);
    await screen.findByText('Reserved seating is not represented.');
    expect(screen.getByRole('button', { name: 'Create dry-run job' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Prepare source' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Commit migration' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rollback eligible entities' })).toBeDisabled();
  });

  it('supports keyboard focus without bypassing exact confirmation', async () => {
    render(<MigrationWorkspace />);
    await waitFor(() => expect(screen.getByLabelText('Migration job')).toHaveTextContent('job_1'));
    const confirmation = screen.getByLabelText(/Type commit:job_1/);
    confirmation.focus();
    fireEvent.change(confirmation, { target: { value: 'commit:job_1' } });
    expect(confirmation).toHaveFocus();
    const commit = screen.getByRole('button', { name: 'Commit migration' });
    commit.focus();
    expect(commit).toHaveFocus();
    fireEvent.click(commit);
    await waitFor(() => expect(api.commitMigration).toHaveBeenCalledWith('job_1', 'commit:job_1'));
  });
});
