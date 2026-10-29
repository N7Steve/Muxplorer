import type { Job } from '@muxplorer/shared';

// An HTTP snapshot can arrive after a newer SSE update. Never roll a job back.
export function mergeJobs(current: Job[], incoming: Job[]): Job[] {
  const jobs = new Map(current.map((job) => [job.id, job]));
  for (const job of incoming) {
    const previous = jobs.get(job.id);
    const newer =
      !previous ||
      (job.revision ?? 0) > (previous.revision ?? 0) ||
      (job.revision === previous.revision && job.updatedAt > previous.updatedAt);
    if (newer) jobs.set(job.id, job);
  }
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 500);
}
