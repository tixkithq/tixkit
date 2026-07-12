import type { PortableAsset, PortableSection } from './manifest.js';

export interface PortabilityFinancialTotals {
  currency: string;
  grossMinor: string;
  refundedMinor: string;
  netMinor: string;
}

export interface PortabilityReconciliationInput {
  expectedCounts: Partial<Record<PortableSection, number>>;
  actualCounts: Partial<Record<PortableSection, number>>;
  expectedAssets: Pick<PortableAsset, 'portableId' | 'sha256'>[];
  actualAssets: Pick<PortableAsset, 'portableId' | 'sha256'>[];
  expectedFinancialTotals?: PortabilityFinancialTotals[];
  actualFinancialTotals?: PortabilityFinancialTotals[];
  unresolvedDependencies: Array<{ portableId: string; reason: string }>;
  requiredRebindingsRemaining: string[];
}

export interface PortabilityReconciliationReport {
  ready: boolean;
  countMismatches: Array<{ section: PortableSection; expected: number; actual: number }>;
  assetMismatches: Array<{ portableId: string; expectedSha256?: string; actualSha256?: string }>;
  financialMismatches: Array<{
    currency: string;
    expected?: PortabilityFinancialTotals;
    actual?: PortabilityFinancialTotals;
  }>;
  unresolvedDependencies: PortabilityReconciliationInput['unresolvedDependencies'];
  requiredRebindingsRemaining: string[];
}

export function reconcilePortableImport(
  input: PortabilityReconciliationInput,
): PortabilityReconciliationReport {
  const sections = new Set([
    ...Object.keys(input.expectedCounts),
    ...Object.keys(input.actualCounts),
  ] as PortableSection[]);
  const countMismatches = [...sections]
    .map((section) => ({
      section,
      expected: input.expectedCounts[section] ?? 0,
      actual: input.actualCounts[section] ?? 0,
    }))
    .filter(({ expected, actual }) => expected !== actual);
  const keyed = <T>(values: T[], keyOf: (value: T) => string, label: string): Map<string, T> => {
    const result = new Map<string, T>();
    for (const value of values) {
      const key = keyOf(value);
      if (result.has(key)) throw new Error(`duplicate portable reconciliation ${label}: ${key}`);
      result.set(key, value);
    }
    return result;
  };
  const expectedAssets = keyed(input.expectedAssets, ({ portableId }) => portableId, 'asset');
  const actualAssets = keyed(input.actualAssets, ({ portableId }) => portableId, 'asset');
  const assetIds = new Set([...expectedAssets.keys(), ...actualAssets.keys()]);
  const assetMismatches = [...assetIds]
    .filter(
      (portableId) =>
        expectedAssets.get(portableId)?.sha256 !== actualAssets.get(portableId)?.sha256,
    )
    .map((portableId) => ({
      portableId,
      ...(expectedAssets.get(portableId)
        ? { expectedSha256: expectedAssets.get(portableId)!.sha256 }
        : {}),
      ...(actualAssets.get(portableId)
        ? { actualSha256: actualAssets.get(portableId)!.sha256 }
        : {}),
    }));
  const expectedFinancial = keyed(
    input.expectedFinancialTotals ?? [],
    ({ currency }) => currency,
    'financial currency',
  );
  const actualFinancial = keyed(
    input.actualFinancialTotals ?? [],
    ({ currency }) => currency,
    'financial currency',
  );
  const currencies = new Set([...expectedFinancial.keys(), ...actualFinancial.keys()]);
  const financialMismatches = [...currencies]
    .filter(
      (currency) =>
        JSON.stringify(expectedFinancial.get(currency)) !==
        JSON.stringify(actualFinancial.get(currency)),
    )
    .map((currency) => ({
      currency,
      ...(expectedFinancial.get(currency) ? { expected: expectedFinancial.get(currency) } : {}),
      ...(actualFinancial.get(currency) ? { actual: actualFinancial.get(currency) } : {}),
    }));
  return {
    ready:
      countMismatches.length === 0 &&
      assetMismatches.length === 0 &&
      financialMismatches.length === 0 &&
      input.unresolvedDependencies.length === 0 &&
      input.requiredRebindingsRemaining.length === 0,
    countMismatches,
    assetMismatches,
    financialMismatches,
    unresolvedDependencies: input.unresolvedDependencies,
    requiredRebindingsRemaining: input.requiredRebindingsRemaining,
  };
}
