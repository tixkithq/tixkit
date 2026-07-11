"use client";

import { useState } from "react";
import { buildOperationExamples } from "./operation-example-builder";

export function OperationExamples(props: {
  method: string;
  path: string;
  operationId: string;
  version: string;
  parameters: readonly unknown[];
  requestBody: unknown;
  security: readonly Record<string, readonly string[]>[];
}) {
  const [language, setLanguage] = useState<
    "curl" | "javascript" | "typescript"
  >("curl");
  const examples = buildOperationExamples(props);
  return (
    <div>
      <div role="tablist" aria-label={`${props.operationId} SDK examples`}>
        {(["curl", "javascript", "typescript"] as const).map((candidate) => (
          <button
            type="button"
            role="tab"
            aria-selected={language === candidate}
            key={candidate}
            onClick={() => setLanguage(candidate)}
          >
            {candidate === "curl"
              ? "cURL"
              : candidate === "javascript"
                ? "JavaScript"
                : "TypeScript"}
          </button>
        ))}
      </div>
      <pre role="tabpanel" tabIndex={0} aria-label={`${language} example`}>
        <code>{examples[language]}</code>
      </pre>
    </div>
  );
}
