export interface Tool {
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string> | string;
  /**
   * EXPLICIT parallel-execution declaration (never inferred). True means the tool only
   * reads — it may run concurrently with other parallel-safe calls (provider.ts batches
   * same-turn calls on this flag) and may be fuzzy-resolved from a near-miss name.
   * Undeclared/false = NOT parallel-safe (fail closed). Declaring true is only legitimate
   * for tools listed in capabilityManifest.TESTED_PARALLEL; manifestIssues and the tests
   * enforce that contract.
   */
  parallelSafe?: boolean;
}
