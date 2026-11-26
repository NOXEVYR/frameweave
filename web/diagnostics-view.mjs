/** The service can include the same discovery snapshot in workflow diagnostics. */
export function mergeDiagnosticChecks(environment = [], workflow = []) {
  const local = environment.map(check => ({ category: 'environment', ...check }));
  const signature = check => JSON.stringify([check.name, check.status, check.detail]);
  const known = new Set(local.map(signature));
  return [...local, ...workflow.filter(check => check.category !== 'environment' || !known.has(signature(check)))
    .map(check => ({ category: 'workflow', ...check }))];
}
