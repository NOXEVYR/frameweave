/** Local library filters. Searches never inspect prompts, workflow inputs or media. */
const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().trim();
export function filterJobs(jobs, status = 'all', query = '', titleFor = () => '') {
  const term = normalize(query);
  return jobs.filter(job => (status === 'all' || status === 'active' && ['queued', 'running'].includes(job.status) || job.status === status)
    && (!term || [titleFor(job), job.id, job.kind, job.error, job.summary?.package_name].some(value => normalize(value).includes(term))));
}
export function filterPackages(packages, scope = 'library', query = '') {
  const term = normalize(query);
  return packages.filter(pack => (scope === 'archived' ? pack.archived === true : !pack.archived && (scope !== 'favorites' || pack.favorite === true))
    && (!term || [pack.name, pack.description, pack.id].some(value => normalize(value).includes(term))))
    .sort((a, b) => Number(b.favorite === true) - Number(a.favorite === true) || String(a.name).localeCompare(String(b.name), 'zh-CN'));
}
