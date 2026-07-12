const forbiddenPatterns = [
  /\b(?:sk|pk|rk|tk)_(?:live|prod)_[A-Za-z0-9_-]+\b/u,
  /\btk_[a-f0-9]{64}\b/u,
  /\btk_sandbox_[a-f0-9]{64}\b/u,
  /\btk_(?:oat|ort)_[A-Za-z0-9_-]+\b/u,
  /\bwhsec_[A-Za-z0-9_-]+\b/u,
  /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/iu,
  /\b[A-Z0-9._%+-]+@(?!example\.(?:com|test)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
];

export function assertPublicArtifactSafe(name: string, contents: string): void {
  if (forbiddenPatterns.some((pattern) => pattern.test(contents)))
    throw new Error(`Public API artifact ${name} contains a credential or non-placeholder PII.`);
}
