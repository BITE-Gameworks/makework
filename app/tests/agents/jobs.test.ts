import { describe, expect, it } from "vitest";
import { askerOf, beginJob, currentJob, isWorking, JobEnded, stopJob } from "../../src/agents/jobs";

describe("jobs", () => {
  it("stops a job and its helper's job", () => {
    const leader = beginJob(1, 7, 0);
    const helper = beginJob(2, 7, 0, leader);
    expect(isWorking(2)).toBe(true);
    expect(askerOf(1)).toBe(7);
    expect(stopJob(1)).toBe(true);
    expect(() => helper.check()).toThrow(JobEnded);
    helper.end();
    leader.end();
    expect(isWorking(1)).toBe(false);
    expect(currentJob(1)).toBeUndefined();
    expect(stopJob(1)).toBe(false);
  });

  it("ends a job over its cap, and counts helper tokens for the leader", () => {
    const leader = beginJob(1, 7, 100);
    const helper = beginJob(2, 7, 0, leader);
    helper.add(60);
    leader.add(60);
    helper.check();
    expect(() => leader.check()).toThrow(/over the limit of 100/);
    helper.end();
    leader.end();
  });

  it("keeps a bot's earlier job running beside a newer one, and stops them all", () => {
    const first = beginJob(4, 7, 0);
    const second = beginJob(4, 8, 0);
    expect(first.signal.aborted).toBe(false);
    expect(askerOf(4)).toBe(8);
    // A member stops only what they asked for.
    expect(stopJob(4, 9)).toBe(false);
    expect(stopJob(4, 7)).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(stopJob(4)).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    second.end();
    expect(isWorking(4)).toBe(true);
    expect(askerOf(4)).toBe(7);
    first.end();
    expect(isWorking(4)).toBe(false);

    const leader = beginJob(5, 7, 0);
    stopJob(5);
    const late = beginJob(6, 7, 0, leader);
    expect(() => late.check()).toThrow(JobEnded);
    late.end();
    leader.end();
  });

  it("has no limit with a cap of 0", () => {
    const job = beginJob(3, 7, 0);
    job.add(1e9);
    expect(() => job.check()).not.toThrow();
    job.end();
  });
});
